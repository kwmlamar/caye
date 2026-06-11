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
