import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Currently-pending held items for a workspace. Used by the intent classifier
 * to build the numbered-list disambiguation context, and by action handlers
 * to resolve "1" / "2" / "the first one" references.
 */
export interface PendingHeldItem {
  index: number // 1-based — what we present to the operator
  conversationId: string
  contactName: string
  channelType: string
  reason: string | null
  proposedReply: string | null
  lastMessagePreview: string | null
  lastMessageAt: string | null
}

export async function getPendingHeldItems(workspaceId: string): Promise<PendingHeldItem[]> {
  const supabase = createServiceClient()

  // Held conversations belong to connected_accounts under this workspace.
  // We join via connected_account_id → connected_accounts.user_id = workspaceId.
  const { data, error } = await supabase
    .from('unified_conversations')
    .select(
      `
      id, customer_name, channel_type, human_agent_reason,
      last_message_preview, last_message_at,
      connected_account:connected_accounts!inner(user_id)
    `
    )
    .eq('connected_account.user_id', workspaceId)
    .eq('human_agent_enabled', true)
    .order('last_message_at', { ascending: false })
    .limit(20)

  if (error || !data) {
    console.error('[pending] held items fetch failed:', error)
    return []
  }

  // Fetch the most recent internal note per conversation in parallel — that's
  // where Caye stashes the proposed reply.
  const items: PendingHeldItem[] = await Promise.all(
    data.map(async (row, i) => {
      const { data: note } = await supabase
        .from('unified_messages')
        .select('metadata')
        .eq('conversation_id', row.id)
        .eq('is_internal', true)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const meta = (note?.metadata ?? {}) as Record<string, unknown>
      const proposed = typeof meta.proposed_reply === 'string' ? (meta.proposed_reply as string) : null

      return {
        index: i + 1,
        conversationId: row.id,
        contactName: row.customer_name ?? 'A guest',
        channelType: row.channel_type,
        reason: row.human_agent_reason,
        proposedReply: proposed,
        lastMessagePreview: row.last_message_preview,
        lastMessageAt: row.last_message_at,
      }
    })
  )

  return items
}

/** Resolve an item_ref ("1", "first", a conversation id) against the pending list. */
export function resolveItemRef(
  items: PendingHeldItem[],
  ref: string | undefined
): PendingHeldItem | null {
  if (!ref) return items.length === 1 ? items[0] : null
  const trimmed = ref.trim().toLowerCase()
  const asNum = Number(trimmed)
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= items.length) {
    return items[asNum - 1]
  }
  if (trimmed === 'first' || trimmed === 'the first one') return items[0] ?? null
  if (trimmed === 'last' || trimmed === 'the last one') return items[items.length - 1] ?? null
  // Direct conversation id
  const direct = items.find((it) => it.conversationId === ref)
  if (direct) return direct
  // Substring match on contact name
  const named = items.find((it) => it.contactName.toLowerCase().includes(trimmed))
  return named ?? null
}
