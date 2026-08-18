import 'server-only'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolResult } from '../types'
import { findHighRiskTool } from '../high-risk-registry'
import { stableArgsKey } from '../high-risk-gate'
import { verifyExternalDraftIntent } from '../external-draft-intent'

interface ConfirmPendingActionInput {
  pending_action_id: string
}

const RENEWED_CONFIRMATION_TTL_MINUTES = 15

/**
 * Execute an action that was already staged, identified by ID.
 *
 * WHY THIS EXISTS (2026-08-08)
 * gateHighRisk confirms by re-derived args: the model must call the same
 * tool a second time with BYTE-IDENTICAL arguments. That assumption broke
 * live, twice.
 *
 *   03:35  agent stages send_reply(body = "Just checking in — did you get…")
 *   10:35  agent shows Lamar a DIFFERENT, freshly written draft in chat
 *   10:36  Lamar: "Yea send that"
 *          agent calls send_reply with the NEW body — never staged —
 *          so the confirmation became a first stage, then hit
 *          "already staged this turn"
 *
 * Result: two staged rows, different bodies, neither executed, and Caye
 * telling the operator "it's staged but not executing." An earlier instance
 * of the same loop had Karenda confirming one send five times in six minutes
 * (2026-08-01) with nothing going out.
 *
 * Byte-equality of model-regenerated text is not something to build a
 * confirmation protocol on. Confirming by ID removes the requirement
 * entirely: the operator approves a specific staged row, and THAT row's
 * stored args are what execute.
 *
 * THIS IS STRICTLY SAFER THAN THE ARGS PATH, not a loosening:
 *   - the args executed are the ones read back from the row whose summary
 *     was shown to the operator, so what was reviewed and what runs cannot
 *     drift apart — the property gateHighRisk's doc comment claims, now
 *     actually guaranteed rather than dependent on the model
 *   - the row is re-checked for freshness, execution, and cancellation here,
 *     so a stale or already-run action can't be replayed
 *   - the same different-request rule applies, so a model cannot stage and
 *     confirm inside one turn
 *   - the target must be in HIGH_RISK_TOOLS, so this can't be aimed at
 *     something that was never gated
 *   - the caller's role is checked against the TARGET tool's roles, not
 *     just this tool's, so confirming can't widen access
 *
 * CAY-10 (2026-08-18): the authorization row has an internal safety TTL, but
 * that is not a business deadline and must never become operator UX. If a real
 * operator confirms after the old authorization is stale, we do NOT execute
 * it. We create a fresh pending row with the exact immutable args + summary,
 * retire the old row in the audit trail, and make the model ask one ordinary
 * fresh confirmation question. No countdowns, expiry notices, or database
 * vocabulary belong in the operator conversation.
 *
 * Deliberately NOT wrapped in gateHighRisk in the registry — staging a
 * confirmation would need its own confirmation, forever.
 */
export const confirmPendingAction: Tool<ConfirmPendingActionInput> = {
  name: 'confirm_pending_action',
  description: `Execute an action you already staged, once the operator has approved it.

Use this INSTEAD of re-calling the original tool. When you stage a high-risk action you get back a pending_action_id — hold onto it. As soon as the operator approves in a NEW message ("yes", "send it", "confirm", "go ahead"), call this with that id and the action runs exactly as it was shown to them.

Do NOT re-call the original tool to confirm. Re-calling only matches if your arguments are byte-identical to what was staged, and any rewording — even fixing a comma — silently stages a SECOND action instead of running the first. That has stranded real sends.

If this tool returns a fresh pending_action_id instead of executing, the earlier approval checkpoint is no longer current. NOTHING HAS HAPPENED YET. Show the same reviewed summary and ask one simple confirmation question again. Do not mention timing windows, expiration, TTLs, staging, database rows, or system mechanics to the operator.

If the operator asked for changes instead of approving, call the original tool again with the corrected arguments (that stages a fresh draft), and confirm THAT id once they approve.`,
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
      .select('id, tool_name, args, summary, created_in_request_id, expires_at, executed_at, cancelled_at, superseded_by')
      .eq('id', args.pending_action_id)
      .eq('workspace_id', ctx.workspaceId)
    // Operator scoping mirrors gateHighRisk exactly, so two operators sharing
    // a workspace's back-office channel can't confirm each other's actions.
    query = ctx.operatorId != null
      ? query.eq('operator_id', ctx.operatorId)
      : query.is('operator_id', null)

    const { data: row } = await query.maybeSingle()

    if (!row) {
      return {
        ok: false,
        error:
          'No staged action with that id for this operator. It may have been staged by someone else — re-stage it and confirm the new id.',
      }
    }
    if (row.executed_at) {
      return {
        ok: false,
        error: `Already executed at ${row.executed_at}. Do not run it again — tell the operator it already went through.`,
      }
    }
    if (row.cancelled_at) {
      // Phase 3 (Part E): a superseded row was cancelled automatically by a
      // newer refinement of the SAME target, not by the operator declining
      // it — tell the model to go confirm the newer one instead of treating
      // this as "nothing is staged anymore."
      return row.superseded_by
        ? {
            ok: false,
            error: `That draft was superseded by a newer one (pending_action_id ${row.superseded_by}) — the operator's last message refined it. Confirm THAT id instead, not this one.`,
          }
        : { ok: false, error: 'That action was cancelled. Stage a fresh one if it is still wanted.' }
    }

    // A scan-origin call can never supply the human half of a confirmation,
    // and a model must not stage and confirm inside one turn.
    if (ctx.origin === 'scan') {
      return { ok: false, error: 'A scan cannot confirm a staged action. Only a real operator reply can.' }
    }
    if (row.created_in_request_id === ctx.requestId) {
      return {
        ok: false,
        error:
          'That action was staged in THIS turn. Relay the summary and stop — it can only be confirmed by a new message from the operator.',
      }
    }

    const tool = findHighRiskTool(row.tool_name as string)
    if (!tool) {
      return { ok: false, error: `Unknown staged tool: ${row.tool_name}` }
    }
    if (!tool.roles.includes(ctx.callerRole)) {
      return {
        ok: false,
        error: `Tool '${tool.name}' is not available to role '${ctx.callerRole}'. Permitted roles: ${tool.roles.join(', ')}.`,
      }
    }

    // CAY-9: a pending external email draft is not permission that lives
    // forever in the conversation. Re-establish destination intent on the
    // actual confirmation turn BEFORE either renewing or claiming the row.
    if (row.tool_name === 'draft_in_inbox') {
      const intentError = await verifyExternalDraftIntent(ctx)
      if (intentError) return intentError
    }

    if (new Date(row.expires_at as string).getTime() <= Date.now()) {
      // The old authorization is stale, so executing it would be unsafe. But
      // the reviewed action itself is still useful. Preserve the exact stored
      // args + summary in a fresh row rather than asking the model to recreate
      // them from conversation text, where recipient/body drift can happen.
      const renewedId = randomUUID()
      const now = new Date()
      const nowISO = now.toISOString()
      const renewedExpiresAt = new Date(
        now.getTime() + RENEWED_CONFIRMATION_TTL_MINUTES * 60 * 1000
      ).toISOString()

      const { error: insertError } = await supabase.from('caye_pending_actions').insert({
        id: renewedId,
        workspace_id: ctx.workspaceId,
        operator_id: ctx.operatorId ?? null,
        tool_name: row.tool_name,
        args: row.args,
        args_key: stableArgsKey(row.args),
        summary: row.summary,
        created_in_request_id: ctx.requestId,
        expires_at: renewedExpiresAt,
      })

      if (insertError) {
        return {
          ok: false,
          error: 'I could not refresh that confirmation safely. Nothing was sent or changed.',
        }
      }

      // Retain the old immutable row for audit while making its replacement
      // explicit. It was already non-executable due to freshness; this link
      // prevents later recovery logic from treating it as an independent item.
      await supabase
        .from('caye_pending_actions')
        .update({ cancelled_at: nowISO, superseded_by: renewedId })
        .eq('id', row.id)

      return {
        ok: true,
        data: {
          pending: true,
          executed: false,
          status: 'awaiting_operator_confirmation',
          pending_action_id: renewedId,
          summary: row.summary,
          renewed_from_pending_action_id: row.id,
          note:
            'NOTHING HAS BEEN SENT OR CHANGED YET. Keep the exact reviewed summary above and ask one natural confirmation question again, such as "Just confirming, you still want me to send this?" Do not mention timing windows, expiration, TTLs, staging, database rows, or system mechanics.',
        },
      }
    }

    // CLAIM BEFORE EXECUTING. The checks above are a read; two confirmations
    // arriving together would both pass them and both send. This conditional
    // update is the actual mutual exclusion — only the caller whose write
    // finds executed_at still null gets the row back, and only that caller
    // runs the tool.
    //
    // The bias is deliberate: if execute() then throws, the row is left
    // marked executed with a null result, which is inspectable and errs
    // toward NOT re-sending. For an irreversible customer send, a missed
    // retry is recoverable by hand; a duplicate send is not.
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
        error: 'That action was already confirmed a moment ago. It has run once — do not run it again.',
      }
    }

    const result = await tool.execute(row.args as never, ctx)

    await supabase.from('caye_pending_actions').update({ result }).eq('id', row.id)

    // Tag which underlying tool actually ran, additively, so the action-
    // grounding guard in execute.ts (lib/caye-agent/action-claim-guard.ts)
    // can tell a real send that arrived via confirmation apart from one
    // that never happened — without this the tool_use block visible to
    // that guard just says "confirm_pending_action", never which action it
    // confirmed.
    const data = result.data
    const taggedData =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), confirmed_tool_name: row.tool_name }
        : data
    return { ...result, data: taggedData }
  },
}
