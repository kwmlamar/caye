/**
 * GET  /api/founder/caye-direct?workspaceId=<uuid>&operatorId=<id>
 * POST /api/founder/caye-direct   { workspaceId, message }
 *
 * Web equivalent of texting Caye's back-office WhatsApp number — same
 * agent (lib/caye-agent, mode: 'back-office'), same
 * caye_operator_messages history, same tools. This is not a toy replica:
 * it's the production back-office agent with a dashboard front end
 * instead of a WhatsApp webhook, so it carries the same real
 * capabilities (and the same trust level) as texting Caye directly.
 *
 * A workspace can have multiple operators (owner, staff, founder) on the
 * back-office channel — GET is scoped to one operator's conversation at a
 * time via operatorId (see /api/founder/caye-operators for the list).
 * POST always sends as the founder viewing the dashboard; there's no way
 * to send as another operator from here — replies to Karenda's messages
 * still go out over her own WhatsApp, not the dashboard.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAgentTurns, isInternalOnlyBody } from '@/lib/caye-operator-messages'
import { resolveFounderOperator } from '@/lib/operator-identity'

/**
 * Collapse immediate repeats (same direction + identical body back to
 * back) before rendering. Fixes duplicate-insert bugs upstream (e.g. two
 * racing cron runs writing the same closing note twice — see
 * decisions-log.md 2026-07-24) showing up as repeated bubbles, without
 * touching the underlying rows or the agent's history replay off this
 * same table. Only merges adjacent matches, so two genuinely separate
 * "yes" replies on different days won't get eaten.
 */
function dedupeConsecutive<T extends { direction: string; body: string }>(rows: T[]): T[] {
  const out: T[] = []
  for (const row of rows) {
    const prev = out[out.length - 1]
    if (prev && prev.direction === row.direction && prev.body === row.body) continue
    out.push(row)
  }
  return out
}

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()

  const operatorIdParam = req.nextUrl.searchParams.get('operatorId')
  let operatorId: number | null
  if (operatorIdParam) {
    operatorId = Number(operatorIdParam)
    if (!Number.isFinite(operatorId)) {
      return NextResponse.json({ error: 'invalid operatorId' }, { status: 400 })
    }
  } else {
    // Default to the founder's own thread when no operator is specified.
    const founderOp = await resolveFounderOperator(supabase, workspaceId)
    operatorId = founderOp?.id ?? null
  }

  let query = supabase
    .from('caye_operator_messages')
    .select('id, direction, body, created_at, wa_delivery_status, wa_delivery_error')
    .eq('workspace_id', workspaceId)

  query = operatorId != null
    ? query.eq('operator_allowlist_id', operatorId)
    : query.is('operator_allowlist_id', null)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(40)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const visible = dedupeConsecutive((data ?? []).filter((m) => !isInternalOnlyBody(m.body)))

  return NextResponse.json({ operatorId, messages: visible.reverse() })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { workspaceId, message } = body as { workspaceId?: string; message?: string }
  if (!workspaceId || !message?.trim()) {
    return NextResponse.json({ error: 'workspaceId and message are required' }, { status: 400 })
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()
  const operator = await resolveFounderOperator(supabase, workspaceId)
  const callerName = operator?.name ?? 'Founder (dashboard)'

  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'inbound',
    wa_message_id: null,
    body: message,
    intent: null,
    claude_format: { role: 'user', content: message },
    operator_allowlist_id: operator?.id ?? null,
    operator_name: operator?.name ?? null,
    operator_role: operator?.role ?? 'founder',
  })

  try {
    const agentResult = await cayeAgent({
      mode: 'back-office',
      workspaceId,
      userMessage: message,
      callerRole: 'founder',
      callerName,
      operatorId: operator?.id ?? null,
    })

    await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator)

    return NextResponse.json({ replyText: agentResult.replyText, operatorId: operator?.id ?? null })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

/**
 * DELETE /api/founder/caye-direct?workspaceId=<uuid>&operatorId=<id>
 *
 * Clears one operator's caye_operator_messages history for this
 * workspace. This IS the agent's conversational memory for back-office
 * mode (see lib/caye-agent/context.ts: loadOperatorContext reads this
 * same table) — clearing it is a real reset, not just a UI wipe. Caye
 * won't recall anything from before the clear on her next reply.
 */
export async function DELETE(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()

  const operatorIdParam = req.nextUrl.searchParams.get('operatorId')
  let operatorId: number | null
  if (operatorIdParam) {
    operatorId = Number(operatorIdParam)
    if (!Number.isFinite(operatorId)) {
      return NextResponse.json({ error: 'invalid operatorId' }, { status: 400 })
    }
  } else {
    const founderOp = await resolveFounderOperator(supabase, workspaceId)
    operatorId = founderOp?.id ?? null
  }

  let query = supabase.from('caye_operator_messages').delete().eq('workspace_id', workspaceId)
  query = operatorId != null
    ? query.eq('operator_allowlist_id', operatorId)
    : query.is('operator_allowlist_id', null)

  const { error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
