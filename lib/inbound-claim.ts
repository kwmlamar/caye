import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Atomically claim an inbound message so at most one concurrent processor
 * (the zoho-email webhook vs the email/poll cron, two overlapping poll
 * ticks, or a webhook redelivery) proceeds to generate a decision and act
 * on it. The INSERT itself is the race gate — via the existing
 * unique_conversation_channel_message_id constraint on unified_messages —
 * not a SELECT beforehand. SELECT-then-INSERT lets two concurrent callers
 * both pass the check and each run their own hold/reply decision.
 *
 * Confirmed live 2026-07-26: Ashley Kukuczka's inbound was held AND
 * auto-replied 0.6s apart because the zoho-email webhook fell through to
 * decision logic even when it lost this exact race.
 */
export async function claimInboundMessage(
  conversationId: string,
  channelMessageId: string,
  row: {
    content: string
    sentAt: string
    metadata?: Record<string, unknown>
  }
): Promise<{ claimed: true } | { claimed: false; error?: string }> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: channelMessageId,
    sender_type: 'customer',
    content: row.content,
    message_type: 'text',
    sent_at: row.sentAt,
    status: 'delivered',
    metadata: row.metadata ?? {},
  })

  if (!error) return { claimed: true }

  // 23505 = unique_violation on (conversation_id, channel_message_id) —
  // another processor already claimed this exact message. Expected under a
  // race, not a real failure.
  if (error.code === '23505') return { claimed: false }

  return { claimed: false, error: error.message }
}
