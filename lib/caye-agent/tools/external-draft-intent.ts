import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { ToolContext, ToolResult } from './types'

/**
 * Compatibility surface for the retired external-mailbox draft path.
 *
 * Owner/operator drafting is inline-only as of 2026-08-18. The live tool is
 * gone from HIGH_RISK_TOOLS/TOOL_REGISTRY. These exports remain temporarily
 * because registry.ts still contains the old wrapper branch; if that branch
 * somehow becomes reachable, it fails closed and routes the model back toward
 * inline drafting rather than restoring external mailbox behavior.
 */
export const EXTERNAL_DRAFT_INTENT_REQUIRED = 'EXTERNAL_DRAFT_RETIRED'

export async function verifyExternalDraftIntent(_ctx: ToolContext): Promise<ToolResult> {
  return {
    ok: false,
    error_code: EXTERNAL_DRAFT_INTENT_REQUIRED,
    error:
      'External mailbox drafts are retired. Compose and show the draft in the current owner conversation instead.',
  }
}

/**
 * Historical cleanup only. When Caye stages a normal inline send_reply draft
 * for a customer, retire any still-live pre-CAY-11 external-draft row for the
 * same customer so a later generic confirmation cannot target it.
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
