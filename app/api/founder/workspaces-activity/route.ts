/**
 * GET /api/founder/workspaces-activity?workspaceIds=<uuid>,<uuid>,...
 *
 * Cross-workspace activity timestamps for the founder's sidebar workspace
 * list (FounderHome). Answers one narrow question per workspace: "when did
 * anything last happen here?" — a front-desk message on any connected
 * channel (whatsapp/instagram/messenger/email, via unified_conversations)
 * or an inbound back-office message (a workspace's own owner/staff texting
 * Caye directly, via caye_operator_messages).
 *
 * Deliberately not per-viewer "unread" tracking — unified_conversations.
 * unread_count is only reliably written by the Gmail poll path (see
 * app/api/email/gmail-poll/route.ts), not the WhatsApp/IG/Messenger
 * webhooks, so it can't answer "any channel" today without a schema change.
 * Returning a raw last-activity timestamp lets the client compare against
 * its own per-workspace "last viewed" watermark instead — same signal
 * strength the caller needs, no migration required.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'

export async function GET(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get('workspaceIds')
  if (!idsParam) return NextResponse.json({ error: 'workspaceIds is required' }, { status: 400 })
  const workspaceIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
  if (workspaceIds.length === 0) return NextResponse.json({ activity: {} })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()

  const [{ data: accounts, error: acctErr }, { data: operatorRows, error: opErr }] = await Promise.all([
    supabase
      .from('connected_accounts')
      .select('id, user_id')
      .in('user_id', workspaceIds),
    supabase
      .from('caye_operator_messages')
      .select('workspace_id, created_at')
      .in('workspace_id', workspaceIds)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(500),
  ])

  if (acctErr) return NextResponse.json({ error: acctErr.message }, { status: 500 })
  if (opErr) return NextResponse.json({ error: opErr.message }, { status: 500 })

  const accountToWorkspace = new Map((accounts ?? []).map((a) => [a.id, a.user_id]))
  const connectedAccountIds = Array.from(accountToWorkspace.keys())

  const { data: conversations, error: convErr } = connectedAccountIds.length
    ? await supabase
        .from('unified_conversations')
        .select('connected_account_id, last_message_at')
        .in('connected_account_id', connectedAccountIds)
        .order('last_message_at', { ascending: false })
        .limit(500)
    : { data: [], error: null }

  if (convErr) return NextResponse.json({ error: convErr.message }, { status: 500 })

  const activity: Record<string, string> = {}
  const bump = (workspaceId: string | undefined, at: string | null) => {
    if (!workspaceId || !at) return
    if (!activity[workspaceId] || at > activity[workspaceId]) activity[workspaceId] = at
  }

  for (const row of conversations ?? []) {
    bump(accountToWorkspace.get(row.connected_account_id), row.last_message_at)
  }
  for (const row of operatorRows ?? []) {
    bump(row.workspace_id, row.created_at)
  }

  return NextResponse.json({ activity })
}
