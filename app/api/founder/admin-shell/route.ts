import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAdminShellTurns } from '@/lib/admin-shell-messages'
import { isInternalTurnBody, visibleBody } from '@/lib/caye-operator-messages'
import { startCodingSessionForRecommendation } from '@/lib/coding-session/recommendation-start'
import { getLatestCodingSession } from '@/lib/coding-session/queries'

export const maxDuration = 180
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_admin_shell_messages')
    .select('id, direction, body, created_at')
    .order('created_at', { ascending: false })
    .limit(40)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const codingSession = await getLatestCodingSession()
  const messages = (data ?? [])
    .filter((m) => !isInternalTurnBody(m.body))
    .map((m) => ({ ...m, body: visibleBody(m.body) }))
    .reverse()
  return NextResponse.json({ messages, codingSession })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  const { message } = body as { message?: string }
  if (!message?.trim()) return NextResponse.json({ error: 'message is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const supabase = createServiceClient()
  await supabase.from('caye_admin_shell_messages').insert({
    direction: 'inbound', body: message, claude_format: { role: 'user', content: message },
  })

  // Free-form /code was an authority/provenance bypass. Coding now starts only
  // from an already accepted, execution-eligible canonical recommendation.
  if (/^\/code\s+/i.test(message.trim())) {
    const replyText = 'Free-form /code is disabled. Start engineering from a canonical accepted recommendation with /code-recommendation <recommendation-id>.'
    await supabase.from('caye_admin_shell_messages').insert({ direction: 'outbound', body: replyText, claude_format: null })
    return NextResponse.json({ error: replyText }, { status: 400 })
  }

  const recommendationMatch = message.trim().match(/^\/code-recommendation\s+([0-9a-f-]{36})$/i)
  if (recommendationMatch) {
    const recommendationId = recommendationMatch[1]
    try {
      const { sessionId } = await startCodingSessionForRecommendation({ recommendationId, workspaceId: null })
      const replyText = `Started the canonical recommendation coding session ${sessionId}. It remains branch-only and cannot merge or deploy itself.`
      await supabase.from('caye_admin_shell_messages').insert({ direction: 'outbound', body: replyText, claude_format: null })
      return NextResponse.json({ replyText, codingSessionId: sessionId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start coding session'
      await supabase.from('caye_admin_shell_messages').insert({ direction: 'outbound', body: `Couldn't start the coding session: ${msg}`, claude_format: null })
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  try {
    const agentResult = await cayeAgent({
      mode: 'admin-shell',
      workspaceId: '00000000-0000-0000-0000-000000000000',
      userMessage: message,
      callerRole: 'founder',
      callerName: user.email ?? 'Founder',
      operatorId: null,
    })
    await persistAdminShellTurns(supabase, agentResult.newTurns)
    return NextResponse.json({ replyText: agentResult.replyText })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Agent failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
