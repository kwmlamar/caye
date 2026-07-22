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
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { cayeAgent } from '@/lib/caye-agent'
import { persistAdminShellTurns } from '@/lib/admin-shell-messages'

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
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_admin_shell_messages')
    .select('id, direction, body, created_at')
    .order('created_at', { ascending: false })
    .limit(40)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ messages: (data ?? []).reverse() })
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
