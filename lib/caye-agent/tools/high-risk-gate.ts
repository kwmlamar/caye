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

/**
 * Short, operator-readable description of a staged action. Best-effort —
 * falls back to the raw tool name for anything not enumerated below.
 *
 * send_reply resolves the recipient's name from conversation_id and puts it
 * FIRST — added 2026-08-06 after a wrong-recipient send reached a customer
 * with nothing in the staged summary to catch it (a legacy WhatsApp-operator
 * dispatch path was the one that actually fired, but this same gap existed
 * here: the summary previewed only the body, never who it was going to, so
 * even a careful "yes, send" gave the operator no way to notice the resolved
 * conversation_id didn't match who they meant).
 */
async function describePendingAction(
  supabase: ReturnType<typeof createServiceClient>,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (toolName) {
    case 'send_reply': {
      // Full body, deliberately NOT truncated. When this was a 140-char
      // preview the agent couldn't show a reviewable draft from the staged
      // summary, so it drafted in plain chat FIRST and asked "Send that?",
      // then called the tool — which staged and asked a second time. Karenda
      // ended up confirming the same one-paragraph send three times across
      // four minutes while mid-thread with a live customer (2026-08-07).
      // Returning the whole body makes the staged summary itself reviewable,
      // so there's exactly one confirmation round-trip and the text shown is
      // the text that will send.
      const body = typeof args.body === 'string' ? args.body : ''
      const conversationId = typeof args.conversation_id === 'string' ? args.conversation_id : null
      const recipient = conversationId ? await describeConversationRecipient(supabase, conversationId) : null
      const heading = recipient ? `Send to ${recipient}:` : 'Send:'
      return `${heading}\n\n${body}`
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
    case 'send_outreach_batch': {
      const items = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : []
      const list = items
        .slice(0, 10)
        .map((it) => `${it.email ?? '?'} — "${it.subject ?? ''}"`)
        .join('; ')
      const overflow = items.length > 10 ? ` and ${items.length - 10} more` : ''
      return `Send ${items.length} cold-outreach email${items.length === 1 ? '' : 's'}: ${list}${overflow}`
    }
    default:
      return `Run ${toolName}`
  }
}

/** Best-effort "Name (channel)" label for a conversation_id, for the
 *  send_reply staged summary. Returns null on any lookup failure — a
 *  missing recipient label degrades to the old body-only summary rather
 *  than blocking staging. */
async function describeConversationRecipient(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('unified_conversations')
    .select('customer_name, channel_type')
    .eq('id', conversationId)
    .maybeSingle()
  if (!data) return null
  const name = (data.customer_name as string | null)?.trim() || 'unknown contact'
  const channel = data.channel_type as string | null
  return channel ? `${name} (${channel})` : name
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
 *
 * ctx.origin (opportunity-scan, 2026-07-28): requestId alone assumed
 * every fresh top-level request meant a real human turn happened. That
 * broke once a periodic system-generated scan became a caller — two
 * independent scan runs each produce a fresh requestId with zero human
 * involved, and without a check here the second run's proposal would
 * read as "confirming" the first and auto-execute. A scan-origin call
 * may only ever stage; only a chat-origin (real inbound message) call
 * may confirm. ttlMinutes is overridable for the same reason — a scan
 * proposal is notify-then-wait-for-a-reply-later, not synchronous chat,
 * so the default 15-minute window would expire before the owner even
 * sees the WhatsApp ping.
 */
export function gateHighRisk<T>(tool: Tool<T>, ttlMinutes: number = PENDING_TTL_MINUTES): Tool<T> {
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

      const summary = await describePendingAction(supabase, tool.name, args as Record<string, unknown>)

      if (existing) {
        if (existing.created_in_request_id !== ctx.requestId && ctx.origin !== 'scan') {
          // Staged in a PRIOR, separate request — a fresh inbound message
          // arrived and the model called this again with the same args.
          // That's the human confirmation. Run it for real.
          //
          // ctx.origin !== 'scan' guard: a scan-origin call can never
          // supply this confirming half, regardless of requestId — see
          // the doc comment above gateHighRisk. Falls through to the
          // "still staged" branch below instead.
          const result = await tool.execute(args, ctx)
          await supabase
            .from('caye_pending_actions')
            .update({ executed_at: new Date().toISOString(), result })
            .eq('id', existing.id)
          return result
        }
        // Either the same request retrying the same call (do not execute
        // twice in one turn no matter how many tool-loop iterations
        // remain), or a scan-origin call re-proposing something already
        // staged (it structurally cannot confirm — see gateHighRisk doc
        // comment). Either way: still pending, don't execute.
        return {
          ok: true,
          data: {
            pending: true,
            summary,
            note:
              ctx.origin === 'scan'
                ? 'Already staged (possibly from an earlier scan) — do not re-propose unless the situation has materially changed. This cannot be confirmed by a scan; only a real reply from the operator confirms it.'
                : 'Already staged this turn — relay the summary to the operator and stop. Do not call this tool again until they reply in a new message.',
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
        expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
      })
      if (error) {
        return { ok: false, error: `Could not stage this action: ${error.message}` }
      }

      return {
        ok: true,
        data: {
          pending: true,
          summary,
          expires_in_minutes: ttlMinutes,
          note: 'Staged, not executed yet. Relay this summary to the operator VERBATIM — for a send_reply it already contains the full draft, so show that and ask one confirmation question ("Send that?"). Do not re-draft it in your own words and do not ask twice. Once they reply affirmatively in a NEW message, call this same tool with the same arguments again to actually run it.',
        },
      }
    },
  } as Tool<T>
}
