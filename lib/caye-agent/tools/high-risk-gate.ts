import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolResult } from './types'

const PENDING_TTL_MINUTES = 15

/**
 * Deterministic JSON with sorted object keys, so the same logical args
 * always produce the same string regardless of key insertion order.
 *
 * Exported so lib/caye-agent/tools/admin/admin-high-risk-gate.ts (the
 * admin-shell analog of this gate, backed by a separate workspace-less
 * table) can reuse it instead of duplicating.
 */
export function stableArgsKey(args: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sort(v)])
      )
    }
    return value
  }
  return JSON.stringify(sort(args))
}

/** Short, operator-readable description of a staged action. Best-effort —
 *  falls back to the raw tool name for anything not enumerated below. */
function describePendingAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'send_reply': {
      const body = typeof args.body === 'string' ? args.body : ''
      const preview = body.length > 140 ? `${body.slice(0, 140)}…` : body
      return `Send: "${preview}"`
    }
    case 'cancel_booking':
      return `Cancel booking ${args.booking_id}${args.reason ? ` (${args.reason})` : ''}`
    case 'reschedule_booking':
      return `Reschedule booking ${args.booking_id} to ${args.new_date}${args.new_time ? ` ${args.new_time}` : ''}`
    case 'confirm_booking':
      return `Confirm booking ${args.booking_id}`
    case 'remove_service':
      return `Remove service "${args.service_name}"`
    case 'remove_blackout_date':
      return `Remove closure matching "${args.match}"`
    case 'remove_team_member':
      return `Remove teammate "${args.phone_or_name}"`
    default:
      return `Run ${toolName}`
  }
}

/**
 * Structural (code-enforced) confirmation gate for HIGH-RISK tools.
 *
 * Before this, the confirmation flow lived entirely in the system prompt
 * — "draft the message, ask, wait for yes, then call the tool." That's
 * data, not a guardrail: a single bad model turn, or an instruction
 * smuggled in through a tool result (e.g. a customer message full of
 * text designed to look like an approved draft), could execute a real
 * customer send or cancellation with nothing in code to catch it. That
 * runs directly against the product's own "conservative and visible"
 * thesis (Products/Caye/STATE.md).
 *
 * Mechanism: the first time a given (workspace, operator, tool, args)
 * combination is seen, execute() only stages a `caye_pending_actions`
 * row and returns it — it never calls the wrapped tool's real execute.
 * The mutation only runs when the SAME tool+args is seen again from a
 * DIFFERENT top-level request (ctx.requestId differs from the row that
 * staged it). Since every top-level request corresponds to one inbound
 * WhatsApp message (see cayeAgent in index.ts), that difference can only
 * happen because a fresh message arrived — i.e. a real human turn
 * happened in between. A model that retries the same call five times in
 * one turn (MAX_TOOL_ITERATIONS) just gets "still staged" back every
 * time; nothing executes until the operator's next message confirms it.
 *
 * This also closes a subtler gap in the old prompt-only flow: previously
 * nothing enforced that the text shown to the operator in chat actually
 * matched the args passed to the tool. Now the summary shown IS derived
 * from the staged args, and the confirming call must supply the exact
 * same args to execute — what's shown and what runs can't drift apart.
 */
export function gateHighRisk<T>(tool: Tool<T>): Tool<T> {
  return {
    ...tool,
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const supabase = createServiceClient()
      const argsKey = stableArgsKey(args)
      const nowISO = new Date().toISOString()

      let existingQuery = supabase
        .from('caye_pending_actions')
        .select('id, created_in_request_id')
        .eq('workspace_id', ctx.workspaceId)
        .eq('tool_name', tool.name)
        .eq('args_key', argsKey)
        .is('executed_at', null)
        .is('cancelled_at', null)
        .gt('expires_at', nowISO)

      existingQuery =
        ctx.operatorId != null
          ? existingQuery.eq('operator_id', ctx.operatorId)
          : existingQuery.is('operator_id', null)

      const { data: existing } = await existingQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const summary = describePendingAction(tool.name, args as Record<string, unknown>)

      if (existing) {
        if (existing.created_in_request_id !== ctx.requestId) {
          // Staged in a PRIOR, separate request — a fresh inbound message
          // arrived and the model called this again with the same args.
          // That's the human confirmation. Run it for real.
          const result = await tool.execute(args, ctx)
          await supabase
            .from('caye_pending_actions')
            .update({ executed_at: new Date().toISOString(), result })
            .eq('id', existing.id)
          return result
        }
        // Same request retrying the same call — do not execute twice in
        // one turn no matter how many tool-loop iterations remain.
        return {
          ok: true,
          data: {
            pending: true,
            summary,
            note: 'Already staged this turn — relay the summary to the operator and stop. Do not call this tool again until they reply in a new message.',
          },
        }
      }

      // Fresh — stage it, don't mutate yet.
      const { error } = await supabase.from('caye_pending_actions').insert({
        workspace_id: ctx.workspaceId,
        operator_id: ctx.operatorId ?? null,
        tool_name: tool.name,
        args,
        args_key: argsKey,
        summary,
        created_in_request_id: ctx.requestId,
        expires_at: new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000).toISOString(),
      })
      if (error) {
        return { ok: false, error: `Could not stage this action: ${error.message}` }
      }

      return {
        ok: true,
        data: {
          pending: true,
          summary,
          expires_in_minutes: PENDING_TTL_MINUTES,
          note: 'Staged, not executed yet. Relay the summary to the operator and ask them to confirm. Once they reply affirmatively in a NEW message, call this same tool with the same arguments again to actually run it.',
        },
      }
    },
  } as Tool<T>
}
