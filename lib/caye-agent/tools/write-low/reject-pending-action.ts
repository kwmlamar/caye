import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { releaseConversationExecution } from '@/lib/conversation-execution'
import type { Tool } from '../types'

interface RejectPendingActionInput {
  pending_action_id: string
  reason?: string
}

/**
 * Decline a staged high-risk action instead of confirming it — the
 * counterpart to confirm_pending_action for the "no" branch. Low risk, not
 * high: declining a proposal touches nothing consequential, unlike the
 * action it declines.
 *
 * Recording a reason matters most for detector-generated proposals (the
 * payment watcher's own record_payment proposals, in particular): without
 * one, a declined proposal is indistinguishable later from one nobody ever
 * looked at. See supabase/migrations/20260905_caye_pending_actions_
 * cancellation_reason.sql.
 */
export const rejectPendingAction: Tool<RejectPendingActionInput> = {
  name: 'reject_pending_action',
  description:
    "Decline a previously staged high-risk action — use when the operator says no, the proposal is " +
    "wrong, or it no longer applies. Optionally record why, so a dropped proposal is distinguishable " +
    "from one nobody reviewed. This does not touch whatever the staged action would have done.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      pending_action_id: {
        type: 'string',
        description: 'The pending_action_id returned when the action was staged.',
      },
      reason: {
        type: 'string',
        description: 'Why this is being declined, if the operator said — e.g. "not our payment" or "wrong invoice".',
      },
    },
    required: ['pending_action_id'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()

    let query = supabase
      .from('caye_pending_actions')
      .select('id, executed_at, cancelled_at, execution_claim_id')
      .eq('id', args.pending_action_id)
      .eq('workspace_id', ctx.workspaceId)
    query = ctx.operatorId != null ? query.eq('operator_id', ctx.operatorId) : query.is('operator_id', null)

    const { data: row } = await query.maybeSingle()
    if (!row) return { ok: false, error: 'No staged action with that id for this operator.' }
    if (row.executed_at) return { ok: false, error: `Already executed at ${row.executed_at} — nothing left to decline.` }
    if (row.cancelled_at) return { ok: true, data: { pending_action_id: row.id, already_cancelled: true } }

    if (row.execution_claim_id) {
      await releaseConversationExecution(row.execution_claim_id as string).catch(() => undefined)
    }

    const reason = args.reason?.trim() || null
    const { error } = await supabase
      .from('caye_pending_actions')
      .update({ cancelled_at: new Date().toISOString(), cancellation_reason: reason })
      .eq('id', row.id)
      .is('executed_at', null)

    if (error) return { ok: false, error: `Could not decline that action: ${error.message}` }
    return { ok: true, data: { pending_action_id: row.id, declined: true, reason } }
  },
}
