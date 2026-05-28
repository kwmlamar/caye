import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userClient = createServerClient(token)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (user.id !== workspaceId) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Scope to this workspace's connected accounts.
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
    .eq('is_active', true)
  const accountIds = (accounts || []).map((a: { id: string }) => a.id)

  // Today's date in the workspace's timezone (fallback UTC).
  const { data: customer } = await supabase
    .from('customers')
    .select('timezone')
    .eq('id', workspaceId)
    .maybeSingle()
  const tz = customer?.timezone || 'UTC'
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }) // YYYY-MM-DD

  // Window: 9pm last night to now (in workspace TZ, approximated via UTC offset of today).
  // For correctness we use "the last 12 hours" as a reasonable proxy for "overnight".
  const overnightStart = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()

  let heldCount = 0
  let overnightHandled = 0
  if (accountIds.length > 0) {
    const heldRes = await supabase
      .from('unified_conversations')
      .select('id', { count: 'exact', head: true })
      .in('connected_account_id', accountIds)
      .eq('is_archived', false)
      .eq('human_agent_enabled', true)
    heldCount = heldRes.count || 0

    // Conversations that the agent handled overnight: an outgoing message
    // from sender_type='ai' since overnightStart, in conversations that are
    // not currently escalated (human_agent_enabled = false).
    const { data: handledRows } = await supabase
      .from('unified_messages')
      .select('conversation_id, conversation:unified_conversations!inner(human_agent_enabled, connected_account_id)')
      .eq('sender_type', 'ai')
      .gte('sent_at', overnightStart)
      .in('conversation.connected_account_id', accountIds)
      .eq('conversation.human_agent_enabled', false)

    const distinctConvos = new Set<string>()
    for (const r of (handledRows || []) as Array<{ conversation_id: string }>) {
      distinctConvos.add(r.conversation_id)
    }
    overnightHandled = distinctConvos.size
  }

  const todayRes = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', workspaceId)
    .eq('booking_date', today)
    .neq('status', 'cancelled')
  const todayBookings = todayRes.count || 0

  return NextResponse.json({ heldCount, todayBookings, overnightHandled })
}
