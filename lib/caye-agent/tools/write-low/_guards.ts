import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import type { ToolResult } from '../types'

/**
 * Verify a conversation row belongs to the given workspace before any
 * write tool mutates it. Defense in depth — tools shouldn't trust the
 * id Claude passed without checking.
 */
export async function assertConversationOwnedByWorkspace(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string,
  workspaceId: string
): Promise<ToolResult> {
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
  const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) {
    return { ok: false, error: 'Workspace has no connected accounts' }
  }
  const { data, error } = await supabase
    .from('unified_conversations')
    .select('id')
    .eq('id', conversationId)
    .in('connected_account_id', accountIds)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) {
    return {
      ok: false,
      error: `Conversation ${conversationId} not found in this workspace`,
    }
  }
  return { ok: true }
}

/**
 * Close out any still-open caye_escalations rows tied to a conversation
 * when the operator disposes of it via chat (mark_handled / skip_held_item)
 * rather than by sending an actual customer-facing reply. Without this,
 * the escalation row stays pending forever — human_agent_enabled flips
 * back to false (so it drops off the Review tab) but
 * escalation-followup/cron's operatorRepliedSince check never fires
 * (no outbound message was actually sent), and the "Needs review" stat
 * card keeps counting a thread nobody can act on anymore.
 */
export async function resolveOpenEscalations(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string
): Promise<void> {
  await supabase
    .from('caye_escalations')
    .update({ owner_responded_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .is('owner_responded_at', null)
}
