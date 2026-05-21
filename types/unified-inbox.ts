export type ChannelType = 'whatsapp' | 'instagram' | 'messenger' | 'email' | 'sms'
export type SenderType = 'customer' | 'business'
export type MessageContentType =
  | 'text' | 'image' | 'video' | 'audio' | 'file'
  | 'location' | 'sticker' | 'template' | 'interactive'
export type MessageDeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type ConversationStatus = 'open' | 'pending' | 'resolved'

export interface ConnectedAccount {
  id: string
  user_id: string
  channel_type: ChannelType
  access_token: string
  refresh_token: string | null
  token_expires_at: string | null
  channel_account_id: string
  channel_account_name: string | null
  metadata: Record<string, unknown>
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface UnifiedConversation {
  id: string
  connected_account_id: string
  channel_type: ChannelType
  channel_conversation_id: string
  customer_name: string | null
  customer_avatar_url: string | null
  customer_id: string
  last_message_at: string | null
  last_message_preview: string | null
  unread_count: number
  is_archived: boolean
  status: ConversationStatus
  metadata: Record<string, unknown>
  ai_summary: Record<string, unknown> | null
  ai_summary_updated_at: string | null
  human_agent_enabled: boolean
  human_agent_reason: string | null
  human_agent_marked_at: string | null
  last_sender_type: 'customer' | 'business' | null
  created_at: string
  updated_at: string
  connected_account?: ConnectedAccount
  messages?: UnifiedMessage[]
}

export interface UnifiedMessage {
  id: string
  conversation_id: string
  channel_message_id: string | null
  sender_type: SenderType
  content: string | null
  message_type: MessageContentType
  sent_at: string
  delivered_at: string | null
  read_at: string | null
  failed_at: string | null
  status: MessageDeliveryStatus
  error_message: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface ConversationWithAccount extends UnifiedConversation {
  connected_account: ConnectedAccount
}
