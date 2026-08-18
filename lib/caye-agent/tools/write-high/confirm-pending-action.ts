import 'server-only'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolResult } from '../types'
import { findHighRiskTool } from '../high-risk-registry'
import { stableArgsKey } from '../high-risk-gate'

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
 * CAY-11 (2026-08-18): external mailbox drafts are retired from the product.
 * Owners draft with Caye inside the active conversation. Historical
 * draft_in_inbox rows may still exist in caye_pending_actions, so this tool
 * explicitly cancels those rows and returns their reviewed body for inline
 * display rather than ever executing them.
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

If this tool returns retired_external_draft=true, an old mailbox-draft action has been retired. Show draft_body inline in the current conversation. Do NOT tell the operator to open Gmail, Zoho, email Drafts, or any external mailbox.

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

    // Product rule: owner/operator drafts live in the conversation, never in
    // an external mailbox. Retire any pre-CAY-11 staged external draft rather
    // than executing it, and preserve the exact reviewed body for Caye to show
    // inline. This runs before high-risk registry lookup because the retired
    // tool is intentionally no longer registered/confirmable.
    if (row.tool_name === 'draft_in_inbox') {
      const nowISO = new Date().toISOString()
      await supabase
        .from('caye_pending_actions')
        .update({ cancelled_at: nowISO })
        .eq('id', row.id)

      const storedArgs = (row.args ?? {}) as Record<string, unknown>
      const body = typeof storedArgs.body === 'string' ? storedArgs.body : ''
      const conversationId =
        typeof storedArgs.conversation_id === 'string' ? storedArgs.conversation_id : null

      return {
        ok: true,
        data: {
          retired_external_draft: true,
          executed: false,
          draft_body: body,
          conversation_id: conversationId,
          note:
            'External mailbox drafts are retired. Show draft_body inline in the current owner conversation. Do not tell the operator to open Gmail, Zoho Mail, email Drafts, or any other mailbox.',
        },
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

    const data = result.data
    const taggedData =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { ...(data as Record<string, unknown>), confirmed_tool_name: row.tool_name }
        : data
    return { ...result, data: taggedData }
  },
}
