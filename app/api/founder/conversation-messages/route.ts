/**
 * GET /api/founder/conversation-messages?workspaceId=<uuid>&conversationId=<uuid>
 *
 * Lazy-loaded thread detail for CommandConversations — fetched only
 * when the founder clicks into a conversation, not prefetched for
 * every row in the list (a workspace can have hundreds).
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS. workspaceId is
 * required and cross-checked against the conversation's
 * connected_account so a founder can't fetch another workspace's
 * thread by guessing a conversation id.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  const conversationId = req.nextUrl.searchParams.get('conversationId')
  if (!workspaceId || !conversationId) {
    return NextResponse.json({ error: 'workspaceId and conversationId are required' }, { status: 400 })
  }

  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()

  const { data: conversation } = await supabase
    .from('unified_conversations')
    .select('id, connected_account_id, customer_name, channel_type, connected_accounts!inner(user_id)')
    .eq('id', conversationId)
    .single()

  const ownerId = (conversation as unknown as { connected_accounts: { user_id: string } } | null)
    ?.connected_accounts?.user_id
  if (!conversation || ownerId !== workspaceId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data: messages, error } = await supabase
    .from('unified_messages')
    .select('id, sender_type, content, sent_at, metadata, is_internal')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    customer_name: conversation.customer_name,
    channel_type: conversation.channel_type,
    messages: messages ?? [],
  })
}
