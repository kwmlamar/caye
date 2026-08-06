/**
 * GET /api/caye/activation-scan/cron
 *
 * Finds signups that finished onboarding and then connected nothing at
 * all, and tells the founder — by name, once.
 *
 * Why a founder ping and not an automated nudge: a workspace with zero
 * channels means Caye is inert. She cannot receive a single guest message,
 * so the customer has had no product at all, and no amount of cheerful
 * automation fixes that. This is the highest-signal churn moment there is,
 * and at current volume a personal message from Lamar is strictly better
 * than anything Caye could send.
 *
 * It has already happened once undetected: Simply Dave Nassau Tours signed
 * up 2026-04-29, connected zero channels ever, and went inactive. Nothing
 * in the product noticed. This is that alarm.
 *
 * Scoped to workspaces with channel_intake set — anything older predates
 * the connect walkthrough and has long since settled its own setup.
 *
 * Authenticated via CRON_SECRET, same dual-header contract as the other
 * cron routes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { recordCronRun } from '@/lib/cron-run-log'

/** Long enough that a same-day connect isn't flagged, short enough to still act on. */
const STALL_HOURS = 48
/** Past this there's no point alerting — they're gone, not stalled. */
const MAX_AGE_DAYS = 14

interface StalledWorkspace {
  workspaceId: string
  businessName: string | null
  ownerPhone: string | null
  hoursSinceSignup: number
}

export async function runActivationScan(): Promise<Record<string, unknown>> {
  const supabase = createServiceClient()
  const now = Date.now()

  const since = new Date(now - MAX_AGE_DAYS * 86400_000).toISOString()
  const until = new Date(now - STALL_HOURS * 3600_000).toISOString()

  // Candidates: onboarded (channel_intake written at discovery completion)
  // and old enough to have had a fair chance.
  const { data: configs, error } = await supabase
    .from('workspace_ai_config')
    .select('workspace_id')
    .not('channel_intake', 'is', null)

  if (error) {
    console.error('[activation-scan] config query failed:', error)
    return { ok: false, error: error.message }
  }

  const workspaceIds = (configs ?? []).map((c: { workspace_id: string }) => c.workspace_id)
  if (!workspaceIds.length) return { ok: true, checked: 0, alerted: 0 }

  const { data: customers } = await supabase
    .from('customers')
    .select('id, business_name, created_at')
    .in('id', workspaceIds)
    .gte('created_at', since)
    .lte('created_at', until)

  const candidates = customers ?? []
  if (!candidates.length) return { ok: true, checked: 0, alerted: 0 }

  const candidateIds = candidates.map((c: { id: string }) => c.id)

  // One query for every candidate's active channels — a per-workspace
  // round trip here would scale badly for no reason.
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('user_id')
    .in('user_id', candidateIds)
    .eq('is_active', true)

  const hasChannel = new Set((accounts ?? []).map((a: { user_id: string }) => a.user_id))

  const { data: owners } = await supabase
    .from('operator_allowlist')
    .select('workspace_id, phone')
    .in('workspace_id', candidateIds)
    .eq('role', 'owner')
    .not('verified_at', 'is', null)

  const ownerPhone = new Map(
    (owners ?? []).map((o: { workspace_id: string; phone: string }) => [o.workspace_id, o.phone])
  )

  const stalled: StalledWorkspace[] = candidates
    .filter((c: { id: string }) => !hasChannel.has(c.id))
    .map((c: { id: string; business_name: string | null; created_at: string }) => ({
      workspaceId: c.id,
      businessName: c.business_name,
      ownerPhone: ownerPhone.get(c.id) ?? null,
      hoursSinceSignup: Math.round((now - new Date(c.created_at).getTime()) / 3600_000),
    }))

  let alerted = 0
  for (const ws of stalled) {
    // One alert per workspace, ever — this is a "go talk to them" prompt,
    // not a recurring reminder. Insert-first so a crash mid-send can't
    // turn into a daily repeat.
    const alertKey = `activation-stall-${ws.workspaceId}`
    const { error: dedupeErr } = await supabase
      .from('caye_founder_alert_log')
      .insert({ alert_key: alertKey })
    if (dedupeErr) continue // 23505 = already alerted

    const { data: setting } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'founder_phone')
      .maybeSingle()

    const founderPhone = setting?.value as string | undefined
    if (!founderPhone) {
      console.warn('[activation-scan] stalled workspace but no founder_phone configured')
      break
    }

    const who = ws.businessName ?? `workspace ${ws.workspaceId.slice(0, 8)}`
    const reach = ws.ownerPhone ? ` — ${ws.ownerPhone}` : ''
    const message =
      `⚠️ ${who} finished onboarding ${ws.hoursSinceSignup}h ago and has connected nothing.${reach}\n\n` +
      `Caye is receiving zero messages for them. Worth a personal note before this goes cold.`

    const { sendFreeFormWhatsApp } = await import('@/lib/whatsapp/outbound')
    const result = await sendFreeFormWhatsApp(founderPhone, message, alertKey)
    if (result.status === 'failed') {
      console.error(`[activation-scan] alert send failed for ${ws.workspaceId}:`, result.error)
    } else {
      alerted++
    }
  }

  return { ok: true, checked: candidates.length, stalled: stalled.length, alerted }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization')
  const headerSecret = req.headers.get('x-cron-secret')
  if (secret && auth !== `Bearer ${secret}` && headerSecret !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await recordCronRun('activation-scan', runActivationScan)
  return NextResponse.json(result)
}
