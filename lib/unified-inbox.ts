import { getSupabase, getWorkspaceId } from './supabase'
import type {
  ConnectedAccount,
  UnifiedConversation,
  UnifiedMessage,
  ConversationWithAccount,
  ChannelType,
} from '@/types/unified-inbox'

// ==================== CONNECTED ACCOUNTS ====================

export async function getConnectedAccounts(): Promise<{
  data: ConnectedAccount[]
  error: string | null
}> {
  const client = getSupabase()
  const { customerId, error: ctxErr } = await getWorkspaceId()
  if (ctxErr || !customerId) return { data: [], error: ctxErr || 'Workspace not found' }

  const { data, error } = await client
    .from('connected_accounts')
    .select('*')
    .eq('user_id', customerId)
    .order('created_at', { ascending: false })

  return { data: (data as ConnectedAccount[]) || [], error: error?.message || null }
}

// ==================== CONVERSATIONS ====================

export async function getUnifiedConversations(
  channelFilter?: ChannelType | 'all',
  search?: string,
  limit = 50,
  showArchived = false
): Promise<{ data: ConversationWithAccount[]; error: string | null }> {
  const client = getSupabase()
  const { customerId, error: ctxErr } = await getWorkspaceId()
  if (ctxErr || !customerId) return { data: [], error: ctxErr || 'Workspace not found' }

  const { data: accounts } = await client
    .from('connected_accounts')
    .select('id')
    .eq('user_id', customerId)

  if (!accounts || accounts.length === 0) return { data: [], error: null }

  const accountIds = accounts.map((a: { id: string }) => a.id)

  let query = client
    .from('unified_conversations')
    .select(`
      *,
      connected_account:connected_accounts(id, channel_type, channel_account_name, channel_account_id, access_token, metadata, is_active, user_id, refresh_token, token_expires_at, created_at, updated_at)
    `)
    .in('connected_account_id', accountIds)
    .eq('is_archived', showArchived)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (channelFilter && channelFilter !== 'all') {
    query = query.eq('channel_type', channelFilter)
  }

  const { data, error } = await query

  let result = (data as ConversationWithAccount[]) || []

  if (search) {
    const q = search.toLowerCase()
    result = result.filter(
      (c) =>
        c.customer_name?.toLowerCase().includes(q) ||
        c.last_message_preview?.toLowerCase().includes(q)
    )
  }

  return { data: result, error: error?.message || null }
}

export async function updateUnifiedConversation(
  id: string,
  updates: Partial<Pick<UnifiedConversation,
    'is_archived' | 'unread_count' | 'status' |
    'human_agent_enabled' | 'human_agent_reason' | 'human_agent_marked_at' |
    'last_sender_type'
  >>
) {
  const client = getSupabase()
  const { error } = await client
    .from('unified_conversations')
    .update(updates)
    .eq('id', id)

  return { error: error?.message || null }
}

// ==================== MESSAGES ====================

export async function getUnifiedMessages(
  conversationId: string,
  limit = 50,
  before?: string
): Promise<{ data: UnifiedMessage[]; error: string | null }> {
  const client = getSupabase()

  let query = client
    .from('unified_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: false })
    .limit(limit)

  if (before) query = query.lt('sent_at', before)

  const { data, error } = await query

  return {
    data: ((data as UnifiedMessage[]) || []).reverse(),
    error: error?.message || null,
  }
}

export async function sendUnifiedMessage(
  conversationId: string,
  content: string,
  messageType: 'text' | 'image' | 'video' | 'file' = 'text'
): Promise<{ data: UnifiedMessage | null; error: string | null }> {
  const client = getSupabase()
  const { data: { session } } = await client.auth.getSession()

  if (!session) return { data: null, error: 'Not authenticated' }

  try {
    const response = await fetch('/api/messages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        content,
        message_type: messageType,
      }),
    })

    const result = await response.json()

    if (!response.ok || !result.success) {
      return { data: null, error: result.error || 'Failed to send message' }
    }

    return { data: result.message as UnifiedMessage, error: null }
  } catch {
    return { data: null, error: 'Failed to connect to messaging server' }
  }
}

export async function saveInternalNote(
  conversationId: string,
  content: string
): Promise<{ data: UnifiedMessage | null; error: string | null }> {
  const client = getSupabase()
  const { data, error } = await client
    .from('unified_messages')
    .insert({
      conversation_id: conversationId,
      channel_message_id: null,
      sender_type: 'business',
      content,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      status: 'sent',
      is_internal: true,
      metadata: {},
    })
    .select()
    .single()

  return { data: data as UnifiedMessage | null, error: error?.message || null }
}

// ==================== REAL-TIME ====================

export function subscribeToUnifiedMessages(
  conversationId: string,
  callback: (message: UnifiedMessage, eventType: 'INSERT' | 'UPDATE') => void
) {
  const client = getSupabase()

  const channel = client
    .channel(`caye_messages:${conversationId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'unified_messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => callback(payload.new as UnifiedMessage, 'INSERT')
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'unified_messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => callback(payload.new as UnifiedMessage, 'UPDATE')
    )
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log(`[Caye Realtime] Messages subscribed for ${conversationId}`)
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[Caye Realtime] Messages ${status}:`, err?.message)
      }
    })

  return () => { client.removeChannel(channel) }
}

export function subscribeToUnifiedConversations(
  accountIds: string[],
  callback: (conversation: UnifiedConversation) => void
) {
  const client = getSupabase()

  const channels = accountIds.map((accountId) =>
    client
      .channel(`caye_conversations:${accountId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'unified_conversations',
          filter: `connected_account_id=eq.${accountId}`,
        },
        (payload) => callback(payload.new as UnifiedConversation)
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log(`[Caye Realtime] Conversations subscribed for account ${accountId}`)
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn(`[Caye Realtime] Conversations ${status}:`, err?.message)
        }
      })
  )

  return () => { channels.forEach((ch) => client.removeChannel(ch)) }
}
