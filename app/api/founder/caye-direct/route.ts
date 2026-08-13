/**
 * GET    /api/founder/caye-direct?workspaceId=<uuid>&operatorId=<id>
 * POST   /api/founder/caye-direct   { workspaceId, message }
 * DELETE /api/founder/caye-direct?workspaceId=<uuid>&operatorId=<id>
 *
 * Operator-scoped view onto caye_operator_messages — same table, same
 * agent (lib/caye-agent, mode: 'back-office') as every WhatsApp turn.
 *
 * As of the 2026-08-13 Caye Direct redesign, this route's job narrowed:
 * it now backs the READ-ONLY operator-observability overlay ("Operators N"
 * → "View operator conversations" in CayeDirect.tsx), letting the founder
 * inspect Max/Mrs. Max's raw WhatsApp history with Caye. The founder's OWN
 * authoring surface moved to the thread-scoped routes at
 * /api/founder/caye-direct/threads — see lib/caye-direct-threads.ts and
 * supabase/migrations/20260813_caye_direct_threads.sql for why (topic
 * threads, not a per-operator switcher).
 *
 * POST is left in place (not deleted — not necessary for this pass) but is
 * no longer wired into the redesigned UI. It still always sends as the
 * founder; there is still no way to send as another operator from here —
 * replies to Karenda's messages still go out over her own WhatsApp, never
 * the dashboard. That invariant is unchanged and must stay unchanged: the
 * observability overlay reusing this GET must never grow a composer.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAgentTurns, isInternalTurnBody, visibleBody, dedupeConsecutive } from '@/lib/caye-operator-messages'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { linkInsertedMessagesToThreads } from '@/lib/caye-direct-threads'

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

  // Drop intermediate tool-loop turns entirely (isInternalTurnBody), then
  // render what's left. A turn carrying a tool call is preamble, not an
  // answer — showing its text as a bubble is what put "Let me check both the
  // held queue and pending quotes at the same time." above the actual reply
  // in Mrs. Max's thread. visibleBody stays as a backstop for markers.
  const visible = dedupeConsecutive(
    (data ?? [])
      .filter((m) => !isInternalTurnBody(m.body))
      .map((m) => ({ ...m, body: visibleBody(m.body) }))
  )

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
    origin: 'dashboard',
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

    const inserted = await persistAgentTurns(supabase, workspaceId, agentResult.newTurns, operator, undefined, undefined, 'dashboard')
    // This route is superseded by the thread-scoped routes and unused by
    // the redesigned UI, but the back-office agent it calls still has
    // relate_to_direct_thread available — link any turn it produces here
    // the same way every other back-office call site does, so a stray
    // call through this path can't leave a thread pointing at a message
    // that was never actually linked to it.
    await linkInsertedMessagesToThreads(supabase, inserted.map((r) => r.id), agentResult.linkedThreadIds)

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
