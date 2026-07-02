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
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { resolveFounderOperator } from '@/lib/operator-identity'

async function requireFounder(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return null
  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) return null
  return user
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
    .select('id, direction, body, created_at')
    .eq('workspace_id', workspaceId)

  query = operatorId != null
    ? query.eq('operator_allowlist_id', operatorId)
    : query.is('operator_allowlist_id', null)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(40)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ operatorId, messages: (data ?? []).reverse() })
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
