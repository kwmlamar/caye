import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { gmailAttachmentDescriptors, ingestNormalizedEmailAttachment, type GmailAttachmentMessage } from './email-attachments'

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const MAX_MESSAGES_PER_ACCOUNT = 25

export interface GmailAttachmentSyncStats {
  accounts: number
  messages: number
  attachments: number
  deduped: number
  errors: number
}

/**
 * Attachment-evidence pass for the scheduled Gmail poll.
 *
 * This intentionally does NOT scan Gmail history. It starts from Caye's own
 * recently-persisted inbound Gmail messages (bounded per connected account),
 * then fetches only those exact provider message IDs and their attachment
 * bytes. That gives reconnect/retry idempotency without turning a cron into a
 * surprise whole-mailbox crawler.
 */
export async function syncRecentGmailAttachmentEvidence(): Promise<GmailAttachmentSyncStats> {
  const db = createServiceClient()
  const stats: GmailAttachmentSyncStats = { accounts: 0, messages: 0, attachments: 0, deduped: 0, errors: 0 }
  const { data: accounts, error } = await db
    .from('connected_accounts')
    .select('id,user_id,access_token,is_active')
    .eq('channel_type', 'gmail')
    .eq('is_active', true)
  if (error) throw new Error(`Gmail attachment account query failed: ${error.message}`)

  for (const account of accounts ?? []) {
    stats.accounts++
    const token = String(account.access_token || '')
    if (!token) { stats.errors++; continue }

    const { data: conversations } = await db
      .from('unified_conversations')
      .select('id')
      .eq('connected_account_id', String(account.id))
      .eq('channel_type', 'gmail')
      .limit(100)
    const conversationIds = (conversations ?? []).map(row => String(row.id))
    if (!conversationIds.length) continue

    const { data: messages } = await db
      .from('unified_messages')
      .select('id,conversation_id,channel_message_id,sent_at,metadata')
      .in('conversation_id', conversationIds)
      .eq('sender_type', 'customer')
      .not('channel_message_id', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(MAX_MESSAGES_PER_ACCOUNT)

    for (const row of messages ?? []) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>
      if (meta.source !== 'gmail' && !meta.gmail_message_id) continue
      const messageId = String(meta.gmail_message_id || row.channel_message_id || '')
      if (!messageId) continue
      stats.messages++
      try {
        const detail = await fetch(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!detail.ok) { stats.errors++; continue }
        const message = await detail.json() as GmailAttachmentMessage
        const descriptors = gmailAttachmentDescriptors({
          workspaceId: String(account.user_id),
          connectedAccountId: String(account.id),
          message,
          conversationId: String(row.conversation_id),
          unifiedMessageId: String(row.id),
        })
        for (const descriptor of descriptors) {
          try {
            const result = await ingestNormalizedEmailAttachment({ descriptor, accessToken: token })
            stats.attachments++
            if (result.deduped) stats.deduped++
          } catch (err) {
            stats.errors++
            console.error('[gmail-attachment-sync] attachment failed', { messageId, attachmentId: descriptor.providerAttachmentId, err })
          }
        }
      } catch (err) {
        stats.errors++
        console.error('[gmail-attachment-sync] message detail failed', { messageId, err })
      }
    }
  }
  return stats
}
