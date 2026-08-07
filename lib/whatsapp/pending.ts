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

/**
 * Pick the draft for a held conversation from the two places Caye writes one.
 * Conversation metadata wins because it's the outreach path's only store; the
 * internal note is the inbound reply-draft path. Exported for regression
 * coverage — see the comment in getPendingHeldItems for why both matter.
 */
export function pickProposedReply(
  conversationMetadata: unknown,
  latestInternalNoteMetadata: unknown
): string | null {
  const read = (source: unknown): string | null => {
    if (!source || typeof source !== 'object') return null
    const value = (source as Record<string, unknown>).proposed_reply
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }
  return read(conversationMetadata) ?? read(latestInternalNoteMetadata)
}

export async function getPendingHeldItems(workspaceId: string): Promise<PendingHeldItem[]> {
  const supabase = createServiceClient()

  // Held conversations belong to connected_accounts under this workspace.
  // We join via connected_account_id → connected_accounts.user_id = workspaceId.
  const { data, error } = await supabase
    .from('unified_conversations')
    .select(
      `
      id, customer_name, channel_type, human_agent_reason, metadata,
      last_message_preview, last_message_at,
      connected_account:connected_accounts!inner(user_id)
    `
    )
    .eq('connected_account.user_id', workspaceId)
    .eq('human_agent_enabled', true)
    .order('last_message_at', { ascending: false })
    // Bumped from 20 → 50 (2026-06-26) — workspaces with bigger
    // historical backlogs (Bimini had 22 held when the bulk-skip test ran)
    // were getting items silently truncated, so "clear all" couldn't reach
    // positions 21+. 50 covers any realistic operator-day pending list
    // without exploding the classifier prompt.
    .limit(50)

  if (error || !data) {
    console.error('[pending] held items fetch failed:', error)
    return []
  }

  // Caye stashes a proposed reply in one of TWO places, and both have to be
  // read here or the draft is invisible to every action handler:
  //
  //   1. unified_conversations.metadata.proposed_reply — written by
  //      create_outreach_leads for cold-outreach first-touch/follow-up drafts,
  //      with no internal message row at all.
  //   2. the most recent internal unified_messages note's metadata — the
  //      reply-draft path used for inbound customer threads.
  //
  // Only (2) was read until 2026-08-07, so every outreach draft reported
  // "No draft on file for <name>" even though the text was sitting right on
  // the conversation — 18 of 19 held items on the TropiTech workspace, which
  // made actionSend structurally incapable of ever succeeding there. The
  // agent's get_pending_quotes tool already reads both; this is the same fix
  // applied to the path the WhatsApp dispatch actually uses.
  const items: PendingHeldItem[] = await Promise.all(
    data.map(async (row, i) => {
      const convProposed = pickProposedReply(row.metadata, null)

      // Skip the per-conversation note lookup when the conversation already
      // carries the draft — that's the outreach path, and it's the majority
      // of held items on an outreach-heavy workspace.
      const { data: note } = convProposed
        ? { data: null }
        : await supabase
            .from('unified_messages')
            .select('metadata')
            .eq('conversation_id', row.id)
            .eq('is_internal', true)
            .order('sent_at', { ascending: false })
            .limit(1)
            .maybeSingle()

      const proposed = pickProposedReply(row.metadata, note?.metadata)

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
