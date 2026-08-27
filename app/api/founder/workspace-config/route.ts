/**
 * GET/PATCH /api/founder/workspace-config?workspaceId=<uuid>
 *
 * Backs the Settings card on Caye Command (2026-07-24, grilled) — the
 * founder-editable view of "how Caye operates for this workspace."
 * Deliberately narrow: only fields confirmed to actually be read at
 * generation/send time made the cut. workspace_ai_config's other
 * onboarding-staging columns (tone, escalation_rules, never_say,
 * pricing_info, cancellation_policy, hold_hours, reply_delay) are NOT
 * exposed here — traced through lib/caye-reply.ts and confirmed none of
 * them are read independently of system_prompt (the discovery flow
 * compiles them INTO system_prompt once; editing them after the fact does
 * nothing without also recompiling, which is out of scope). Surfacing them
 * would be editable UI that silently does nothing — worse than not having
 * the field at all.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS (same pattern as
 * /api/founder/caye-toggle) — not exposed to workspace owners. Founders
 * can edit ANY workspace's config from here, including a customer's
 * (Bimini), which is the whole point — a fast override path that doesn't
 * require walking the owner through chat or their own settings page.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import type { VoiceProfile } from '@/lib/voice-profile'
import { pauseOutreachForOwner, resumeOwnerPausedOutreach, founderOverrideResolvedBounceSafetyPause } from '@/lib/outreach-pause-control'

interface WorkspaceConfigPatch {
  system_prompt?: string | null
  digest_days?: number[]
  autosend_enabled?: boolean
  ai_voice_profile?: VoiceProfile | null
  outreach_autosend_paused?: boolean
  outreach_override_justification?: string
}

async function requireFounder(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return { ok: false as const, status: 401, error: 'Unauthorized' }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return { ok: false as const, status: 403, error: 'Forbidden' }
  }
  return { ok: true as const }
}

export async function GET(req: NextRequest) {
  const auth = await requireFounder(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const supabase = createServiceClient()
  const [{ data: aiConfig, error: aiConfigErr }, { data: customer, error: customerErr }] = await Promise.all([
    supabase.from('workspace_ai_config').select('system_prompt, digest_days, outreach_autosend_paused, outreach_bounce_threshold, outreach_bounce_window_hours').eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('customers').select('workspace_kind, autosend_enabled, ai_voice_profile').eq('id', workspaceId).maybeSingle(),
  ])
  if (aiConfigErr) return NextResponse.json({ error: aiConfigErr.message }, { status: 500 })
  if (customerErr) return NextResponse.json({ error: customerErr.message }, { status: 500 })

  return NextResponse.json({
    system_prompt: aiConfig?.system_prompt ?? '',
    digest_days: aiConfig?.digest_days ?? [0, 1, 2, 3, 4, 5, 6],
    autosend_enabled: customer?.autosend_enabled ?? false,
    workspace_kind: customer?.workspace_kind ?? null,
    ai_voice_profile: customer?.ai_voice_profile ?? null,
    outreach_autosend_paused: aiConfig?.outreach_autosend_paused ?? true,
    outreach_bounce_threshold: aiConfig?.outreach_bounce_threshold ?? 5,
    outreach_bounce_window_hours: aiConfig?.outreach_bounce_window_hours ?? 24,
  })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireFounder(req)
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as WorkspaceConfigPatch
  const supabase = createServiceClient()

  const aiConfigPatch: Record<string, unknown> = {}
  if (body.system_prompt !== undefined) aiConfigPatch.system_prompt = body.system_prompt
  if (body.digest_days !== undefined) {
    if (!Array.isArray(body.digest_days) || body.digest_days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return NextResponse.json({ error: 'digest_days must be integers 0-6' }, { status: 400 })
    }
    aiConfigPatch.digest_days = body.digest_days
  }

  const customerPatch: Record<string, unknown> = {}
  if (body.ai_voice_profile !== undefined) customerPatch.ai_voice_profile = body.ai_voice_profile
  if (body.autosend_enabled !== undefined) customerPatch.autosend_enabled = body.autosend_enabled

  if (Object.keys(aiConfigPatch).length === 0 && Object.keys(customerPatch).length === 0 && body.outreach_autosend_paused === undefined) {
    return NextResponse.json({ error: 'No recognized fields in patch body' }, { status: 400 })
  }

  if (Object.keys(aiConfigPatch).length > 0) {
    const { error } = await supabase.from('workspace_ai_config').upsert({ workspace_id: workspaceId, ...aiConfigPatch }, { onConflict: 'workspace_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (body.outreach_autosend_paused === true) {
    try {
      await pauseOutreachForOwner(workspaceId, 'Paused by founder in workspace settings', 'founder')
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not pause outreach' }, { status: 500 })
    }
  }

  if (body.outreach_autosend_paused === false) {
    try {
      let result = await resumeOwnerPausedOutreach(workspaceId, 'founder')
      // Defense in depth: only the exact resolved bounce-safety disposition
      // may even reach the founder-only override. Unknown/provider/compliance
      // states remain blocked at this outer route as well as inside the
      // override function itself.
      if (
        result.disposition === 'safety_recovery_not_supported' &&
        result.source === 'bounce_safety' &&
        body.outreach_override_justification
      ) {
        result = await founderOverrideResolvedBounceSafetyPause(workspaceId, body.outreach_override_justification)
      }
      if (result.disposition !== 'running') {
        return NextResponse.json({ error: 'Outreach remains paused because its safety provenance cannot be overridden here.', pause: result }, { status: 409 })
      }
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not resume outreach' }, { status: 500 })
    }
  }

  if (Object.keys(customerPatch).length > 0) {
    const { error } = await supabase.from('customers').update(customerPatch).eq('id', workspaceId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
