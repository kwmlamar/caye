/**
 * GET  /api/founder/channels?workspaceId=<uuid>
 * PATCH /api/founder/channels
 *
 * Connected-channel status for a single workspace (WhatsApp, Instagram,
 * Messenger, Zoho Mail, Gmail, SMS), for the founder console's Channels
 * card on FounderHome — a founder-facing view onto the same
 * connected_accounts rows components/settings/ChannelsPanel.tsx already
 * reads client-side. That component queries connected_accounts directly
 * from the browser, which only works for the workspace's own
 * owner/staff session; founders viewing a workspace they don't belong to
 * need a service-role read, same shape as /api/founder/contacts.
 *
 * PATCH disconnects (is_active: false) — mirrors ChannelsPanel's
 * handleDisconnect. Actually *connecting* a channel is unchanged: the
 * card links straight to the existing /api/auth/{zoho,gmail,meta} OAuth
 * initiators, which take workspaceId with no ownership gate already (by
 * design — the OAuth state param carries workspaceId through the
 * provider round-trip, same as when a workspace owner connects from
 * their own settings page).
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

interface ConnectedAccountRow {
  id: string
  channel_type: string
  channel_account_name: string | null
  channel_username: string | null
  channel_account_id: string | null
  is_active: boolean
  needs_reauth: boolean | null
  created_at: string
}

async function requireFounder(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return null
  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) return null
  return user
}

// When a channel type has multiple rows, prefer the active one; break
// ties by newest created_at — same tie-break as ChannelsPanel.pickBest.
function pickBest(rows: ConnectedAccountRow[]): ConnectedAccountRow {
  const active = rows.filter((r) => r.is_active)
  const pool = active.length > 0 ? active : rows
  return pool.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
}

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })

  const supabase = createServiceClient()

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('connected_accounts')
    .select('id, channel_type, channel_account_name, channel_username, channel_account_id, is_active, needs_reauth, created_at')
    .eq('user_id', workspaceId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const grouped: Record<string, ConnectedAccountRow[]> = {}
  for (const row of (data ?? []) as ConnectedAccountRow[]) {
    if (!grouped[row.channel_type]) grouped[row.channel_type] = []
    grouped[row.channel_type].push(row)
  }
  const byType: Record<string, ConnectedAccountRow> = {}
  for (const [type, rows] of Object.entries(grouped)) byType[type] = pickBest(rows)

  return NextResponse.json({ channels: byType })
}

export async function PATCH(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const { workspaceId, accountId } = body as { workspaceId?: string; accountId?: string }
  if (!workspaceId || !accountId) {
    return NextResponse.json({ error: 'workspaceId and accountId are required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await supabase
    .from('connected_accounts')
    .update({ is_active: false })
    .eq('id', accountId)
    .eq('user_id', workspaceId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
