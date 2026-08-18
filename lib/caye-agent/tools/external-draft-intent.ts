import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ToolContext } from './types'

/**
 * Compatibility cleanup for the retired external-mailbox draft path.
 *
 * Owner/operator drafting is inline-only as of 2026-08-18. Historical
 * draft_in_inbox pending rows can still exist until they are cancelled or
 * confirmed; when Caye stages a normal inline send_reply draft for the same
 * customer, retire any still-live external-draft row so a later generic
 * confirmation cannot target the obsolete destination.
 */
export async function cancelPendingExternalDraftsForConversation(args: {
  ctx: ToolContext
  conversationId: string
}): Promise<void> {
  const supabase = createServiceClient()
  const nowISO = new Date().toISOString()

  let query = supabase
    .from('caye_pending_actions')
    .select('id, args')
    .eq('workspace_id', args.ctx.workspaceId)
    .eq('tool_name', 'draft_in_inbox')
    .is('executed_at', null)
    .is('cancelled_at', null)
    .gt('expires_at', nowISO)

  query =
    args.ctx.operatorId != null
      ? query.eq('operator_id', args.ctx.operatorId)
      : query.is('operator_id', null)

  const { data: rows } = await query
  const stale = (rows ?? []).filter(
    (row) =>
      (row.args as Record<string, unknown> | null)?.conversation_id === args.conversationId
  )

  for (const row of stale) {
    await supabase
      .from('caye_pending_actions')
      .update({ cancelled_at: nowISO })
      .eq('id', row.id as string)
  }
}
