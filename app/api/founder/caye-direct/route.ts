/**
 * GET  /api/founder/caye-direct?workspaceId=<uuid>
 * POST /api/founder/caye-direct   { workspaceId, message }
 *
 * Web equivalent of texting Caye's back-office WhatsApp number — same
 * agent (lib/caye-agent, mode: 'back-office'), same
 * caye_operator_messages history, same tools. This is not a toy replica:
 * it's the production back-office agent with a dashboard front end
 * instead of a WhatsApp webhook, so it carries the same real
 * capabilities (and the same trust level) as texting Caye directly.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAgentTurns } from '@/lib/caye-operator-messages'

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
  const { data, error } = await supabase
    .from('caye_operator_messages')
    .select('id, direction, body, created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(40)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ messages: (data ?? []).reverse() })
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

  await supabase.from('caye_operator_messages').insert({
    workspace_id: workspaceId,
    direction: 'inbound',
    wa_message_id: null,
    body: message,
    intent: null,
    claude_format: { role: 'user', content: message },
  })

  try {
    const agentResult = await cayeAgent({
      mode: 'back-office',
      workspaceId,
      userMessage: message,
      callerRole: 'founder',
      callerName: 'Founder (dashboard)',
    })

    await persistAgentTurns(supabase, workspaceId, agentResult.newTurns)

    return NextResponse.json({ replyText: agentResult.replyText })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
