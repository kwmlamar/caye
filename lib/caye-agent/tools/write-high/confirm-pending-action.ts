import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolResult } from '../types'
import { findHighRiskTool } from '../high-risk-registry'
import { verifyExternalDraftIntent } from '../external-draft-intent'
import { assertConversationOwnedByWorkspace } from '../write-low/_guards'

interface ConfirmPendingActionInput {
  pending_action_id: string
}

/**
 * Execute the exact stored args for one previously staged high-risk action.
 * Confirmation never re-derives customer-facing content. CAY-111 additionally
 * revalidates conversation identity before the atomic claim so a stale thread
 * id cannot be recorded as executed merely because the operator approved the
 * draft that happened to carry it.
 */
export const confirmPendingAction: Tool<ConfirmPendingActionInput> = {
  name: 'confirm_pending_action',
  description: `Execute an action you already staged, once the operator has approved it.

Use this INSTEAD of re-calling the original tool. When you stage a high-risk action you get back a pending_action_id. On a NEW operator message approving that exact staged action, call this id and the stored args execute exactly as reviewed.

If the operator asked for changes, stage the corrected action first and confirm the NEW id. Never confirm an older/superseded draft.`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      pending_action_id: {
        type: 'string',
        description: 'The pending_action_id returned when the action was staged.',
      },
    },
    required: ['pending_action_id'],
  },

  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const supabase = createServiceClient()

    let query = supabase
      .from('caye_pending_actions')
      .select('id, tool_name, args, summary, created_in_request_id, expires_at, executed_at, cancelled_at, superseded_by, execution_claim_id')
      .eq('id', args.pending_action_id)
      .eq('workspace_id', ctx.workspaceId)
    query =
      ctx.operatorId != null
        ? query.eq('operator_id', ctx.operatorId)
        : query.is('operator_id', null)

    const { data: row } = await query.maybeSingle()
    if (!row) {
      return {
        ok: false,
        error:
          'No staged action with that id for this operator. Re-stage it from current business state before confirming.',
      }
    }
    if (row.executed_at) {
      return {
        ok: false,
        error: `Already executed at ${row.executed_at}. Do not run it again.`,
      }
    }
    if (row.cancelled_at) {
      return row.superseded_by
        ? {
            ok: false,
            error: `That draft was superseded by a newer one (pending_action_id ${row.superseded_by}). Confirm the newer id instead.`,
          }
        : { ok: false, error: 'That action was cancelled. Stage a fresh one if it is still wanted.' }
    }
    if (new Date(row.expires_at as string).getTime() <= Date.now()) {
      return {
        ok: false,
        error:
          'That staged action expired. Nothing was sent or changed. Re-read current state, stage it again, and ask for confirmation.',
      }
    }
    if (ctx.origin === 'scan') {
      return { ok: false, error: 'A scan cannot confirm a staged action. Only a real operator reply can.' }
    }
    if (row.created_in_request_id === ctx.requestId) {
      return {
        ok: false,
        error:
          'That action was staged in this turn. It can only be confirmed by a new operator message.',
      }
    }

    if (row.tool_name === 'draft_in_inbox') {
      const intentError = await verifyExternalDraftIntent(ctx)
      if (intentError) return intentError
    }

    const storedArgs = (row.args ?? {}) as Record<string, unknown>

    // CAY-111: a staged customer-facing action can outlive the conversation
    // identity the model originally selected. Revalidate the exact id against
    // CURRENT workspace ownership before claiming the row. We deliberately do
    // not fuzzy-recover by customer name: wrong-recipient recovery is worse
    // than asking Caye to re-fetch/restage the current thread.
    if (row.tool_name === 'send_reply' || row.tool_name === 'draft_in_inbox') {
      const conversationId =
        typeof storedArgs.conversation_id === 'string' ? storedArgs.conversation_id : ''
      if (!conversationId) {
        return {
          ok: false,
          status: 'CONFLICT',
          error_code: 'STALE_CONVERSATION_IDENTITY',
          error:
            'The staged customer action has no conversation identity. Nothing was executed; re-fetch the customer thread and stage a new action.',
        }
      }
      const ownership = await assertConversationOwnedByWorkspace(
        supabase,
        conversationId,
        ctx.workspaceId
      )
      if (!ownership.ok) {
        return {
          ok: false,
          status: 'CONFLICT',
          error_code: 'STALE_CONVERSATION_IDENTITY',
          error: `The staged conversation is no longer a current thread in this workspace (${ownership.error ?? 'identity mismatch'}). Nothing was executed. Re-fetch the customer by authoritative identity and stage the reply again.`,
        }
      }
    }

    const tool = findHighRiskTool(row.tool_name as string)
    if (!tool) return { ok: false, error: `Unknown staged tool: ${row.tool_name}` }
    if (!tool.roles.includes(ctx.callerRole)) {
      return {
        ok: false,
        error: `Tool '${tool.name}' is not available to role '${ctx.callerRole}'. Permitted roles: ${tool.roles.join(', ')}.`,
      }
    }

    // The claim acquired while staging is the operator's ownership token.
    // Pass it to the actual send boundary only after all confirmation checks
    // have succeeded; a stale/expired claim fails closed there.
    if (row.execution_claim_id) ctx.executionClaimId = row.execution_claim_id as string

    // Atomic claim: only one concurrent confirmation can cross this boundary.
    const { data: claimed } = await supabase
      .from('caye_pending_actions')
      .update({ executed_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('executed_at', null)
      .select('id')
      .maybeSingle()

    if (!claimed) {
      return {
        ok: false,
        error: 'That action was already confirmed a moment ago. Do not run it again.',
      }
    }

    const result = await tool.execute(row.args as never, ctx)
    await supabase.from('caye_pending_actions').update({ result }).eq('id', row.id)

    const data = result.data
    const taggedData =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), confirmed_tool_name: row.tool_name }
        : data
    return { ...result, data: taggedData }
  },
}
