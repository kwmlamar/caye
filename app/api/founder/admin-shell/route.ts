/**
 * GET  /api/founder/admin-shell
 * POST /api/founder/admin-shell   { message }
 *
 * Founder-only dev/ops console (2026-07-21) — a sibling of Caye Direct
 * (app/api/founder/caye-direct/route.ts) but NOT the same agent: this
 * calls lib/caye-agent, mode: 'admin-shell' (business-ops-free, no
 * workspace), backed by its own history table (caye_admin_shell_messages)
 * and its own high-risk gate (caye_admin_pending_actions) rather than
 * back-office's workspace/operator-scoped ones.
 *
 * Single global thread — no workspaceId/operatorId params, unlike Caye
 * Direct, since there's exactly one caller (the founder) and no per-
 * workspace concept here at all.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS — identical pattern
 * to caye-direct/route.ts.
 *
 * Second gear (2026-07-26): a `/code <task>` prefix on the message bypasses
 * cayeAgent entirely and boots a real Claude Code CLI session in an
 * ephemeral, credential-isolated Vercel Sandbox (lib/coding-session/*) —
 * deliberately NOT modeled as an LLM-invoked tool, since `/code` is a
 * deterministic string match, not something worth routing through a tool
 * loop.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAdminShellTurns } from '@/lib/admin-shell-messages'
import { startCodingSession } from '@/lib/coding-session/start'
import { getLatestCodingSession } from '@/lib/coding-session/queries'

export const maxDuration = 180

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

  return NextResponse.json({ messages: (data ?? []).reverse(), codingSession })
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { message } = body as { message?: string }
  if (!message?.trim()) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()

  await supabase.from('caye_admin_shell_messages').insert({
    direction: 'inbound',
    body: message,
    claude_format: { role: 'user', content: message },
  })

  const codeMatch = message.trim().match(/^\/code\s+([\s\S]+)$/)
  if (codeMatch) {
    const task = codeMatch[1].trim()
    try {
      const { sessionId } = await startCodingSession({ task, requestedBy: user.id })
      const replyText = `Started a coding session for: "${task}". I'll ping you on WhatsApp when it's done.`
      await supabase.from('caye_admin_shell_messages').insert({
        direction: 'outbound',
        body: replyText,
        claude_format: null,
      })
      return NextResponse.json({ replyText, codingSessionId: sessionId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start coding session'
      await supabase.from('caye_admin_shell_messages').insert({
        direction: 'outbound',
        body: `Couldn't start the coding session: ${msg}`,
        claude_format: null,
      })
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  try {
    const agentResult = await cayeAgent({
      mode: 'admin-shell',
      // Ignored by runAdminShellAgent (lib/caye-agent/index.ts) — required
      // only because CayeAgentInput.workspaceId is non-optional for every
      // other mode. admin-shell has no workspace concept.
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
