import 'server-only'
import { randomUUID } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolResult } from './types'
import { claimConversationExecution, releaseConversationExecution } from '@/lib/conversation-execution'
import { classifyHighRiskDecision, decisionSubjectKey, requiredAuthorityForDomain, resolveWorkspaceDecisionAuthority, routeBusinessDecision, type DecisionAuthorityResolution, type DecisionDomain } from '@/lib/decision-authority'

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
 * What underlying thing a staged action is ABOUT, for supersession
 * matching (Part E). Deliberately narrow and conservative: only the two
 * identifier shapes every high-risk tool's args actually use today.
 * Returns null for a tool whose args carry neither — supersession is
 * skipped rather than guessed for those (e.g. remove_service, which acts
 * on the workspace as a whole, not one target you'd "refine").
 */
export function extractTargetKey(args: Record<string, unknown>): string | null {
  if (typeof args.conversation_id === 'string') return `conversation:${args.conversation_id}`
  if (typeof args.booking_id === 'string') return `booking:${args.booking_id}`
  return null
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
    case 'draft_in_inbox': {
      // Not a send — spelled out here too, not just in the tool's own
      // result, because this summary is what the operator sees BEFORE
      // confirming (2026-08-17, Pam Ott incident: the prior low-risk path
      // let this happen with no summary shown at all).
      const body = typeof args.body === 'string' ? args.body : ''
      const conversationId = typeof args.conversation_id === 'string' ? args.conversation_id : null
      const recipient = conversationId ? await describeConversationRecipient(supabase, conversationId) : null
      const heading = recipient
        ? `Not sent — file this into your email drafts on ${recipient}'s thread, for you to open, attach anything, and send yourself:`
        : 'Not sent — file this into your email drafts, for you to open, attach anything, and send yourself:'
      return `${heading}\n\n${body}`
    }
    case 'cancel_booking':
      return `Cancel booking ${args.booking_id}${args.reason ? ` (${args.reason})` : ''}`
    case 'reschedule_booking':
      return `Reschedule booking ${args.booking_id} to ${args.new_date}${args.new_time ? ` ${args.new_time}` : ''}`
    case 'confirm_booking':
      return `Confirm booking ${args.booking_id}`
    case 'create_customer_booking':
      return `Create pending booking for ${args.customer_name ?? 'customer'}: ${args.booking_date ?? 'date'} at ${args.booking_time ?? 'time'} for ${args.number_of_people ?? '?'} guest(s)`
    case 'remove_service':
      return `Remove service "${args.service_name}"`
    case 'remove_blackout_date':
      return `Remove closure matching "${args.match}"`
    case 'remove_team_member':
      return `Remove teammate "${args.phone_or_name}"`
    case 'record_payment': {
      // Deliberately no live invoice lookup here — describePendingAction has
      // no workspaceId to scope one with, and record_payment's own notes
      // field (set by whoever staged it, e.g. the payment watcher) already
      // carries the human-readable context: sender, confidence, source.
      const amount = typeof args.amount === 'number' ? args.amount.toFixed(2) : String(args.amount ?? '?')
      const notes = typeof args.notes === 'string' && args.notes ? ` — ${args.notes}` : ''
      return `Record a $${amount} payment${notes}. Nothing recorded until you confirm.`
    }
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
        .select('id, created_in_request_id, execution_claim_id')
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

      let { data: existing } = await existingQuery
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const summary = await describePendingAction(supabase, tool.name, args as Record<string, unknown>)
      const decisionDomain: DecisionDomain | null = classifyHighRiskDecision(tool.name)
      let decisionAuthority: DecisionAuthorityResolution | null = null
      let approvalOperatorId = ctx.operatorId ?? null
      if (decisionDomain) {
        decisionAuthority = await resolveWorkspaceDecisionAuthority({
          workspaceId: ctx.workspaceId,
          actorOperatorId: ctx.operatorId,
          requiredAuthority: requiredAuthorityForDomain(decisionDomain),
        })
        if (!decisionAuthority.actorAuthorized) {
          approvalOperatorId = decisionAuthority.preferredDecisionOwner?.id ?? null
          if (approvalOperatorId == null) {
            const unresolved = await routeBusinessDecision({
              ctx,
              domain: decisionDomain,
              risk: 'high',
              subjectKey: decisionSubjectKey([tool.name, argsKey]),
              summary,
              resolution: decisionAuthority,
              evidence: { source: 'high_risk_gate', toolName: tool.name, argsKey },
            })
            return unresolved.result
          }
        }
      }

      // Re-scope the existing lookup to the actual decision owner when the
      // conversation actor is not authorized. The query was built above
      // before authority resolution, so rebuild only that narrow case.
      if (decisionAuthority && !decisionAuthority.actorAuthorized && approvalOperatorId != null) {
        let ownerQuery = supabase
          .from('caye_pending_actions')
          .select('id, created_in_request_id, execution_claim_id')
          .eq('workspace_id', ctx.workspaceId)
          .eq('tool_name', tool.name)
          .eq('args_key', argsKey)
          .is('executed_at', null)
          .is('cancelled_at', null)
          .gt('expires_at', nowISO)
          .eq('operator_id', approvalOperatorId)
        const ownerExisting = await ownerQuery.order('created_at', { ascending: false }).limit(1).maybeSingle()
        existing = ownerExisting.data
      }

      if (existing) {
        if (decisionDomain && decisionAuthority && !decisionAuthority.actorAuthorized) {
          const routed = await routeBusinessDecision({
            ctx,
            domain: decisionDomain,
            risk: 'high',
            subjectKey: decisionSubjectKey([tool.name, argsKey]),
            summary,
            resolution: decisionAuthority,
            evidence: { source: 'high_risk_gate', toolName: tool.name, argsKey, pendingActionId: existing.id },
          })
          return { ...routed.result, data: { ...(routed.result.data as Record<string, unknown> ?? {}), pending_action_id: existing.id } }
        }
        if (existing.created_in_request_id !== ctx.requestId && ctx.origin !== 'scan') {
          // Staged in a PRIOR, separate request — a fresh inbound message
          // arrived and the model called this again with the same args.
          // That's the human confirmation. Run it for real.
          //
          // ctx.origin !== 'scan' guard: a scan-origin call can never
          // supply this confirming half, regardless of requestId — see
          // the doc comment above gateHighRisk. Falls through to the
          // "still staged" branch below instead.
          //
          // This is a SECOND, separate confirmation path from
          // confirm_pending_action.ts (the model re-emitting the identical
          // tool call, rather than calling confirm_pending_action) — it
          // must thread the SAME execution claim through, or the tool's own
          // validate/complete/resolve calls silently no-op (ctx.executionClaimId
          // undefined) and this send bypasses coordination entirely.
          if (existing.execution_claim_id) {
            ctx.executionClaimId = existing.execution_claim_id as string
          }
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
            // NOT SENT / NOT DONE. Spelled out because `ok: true` plus a
            // summary reading "Send to <name> (email): ..." scanned as a
            // completed send and Caye twice told an operator a follow-up had
            // gone out when nothing had (2026-08-07). The flags say it now.
            executed: false,
            status: 'awaiting_operator_confirmation',
            pending_action_id: existing.id,
            summary,
            note:
              ctx.origin === 'scan'
                ? 'NOTHING HAS HAPPENED YET. Already staged (possibly from an earlier scan) — do not re-propose unless the situation has materially changed. This cannot be confirmed by a scan; only a real reply from the operator confirms it.'
                : 'NOTHING HAS HAPPENED YET — do not tell the operator this was sent or done. Already staged this turn: relay the summary and stop. When they approve in a NEW message, call confirm_pending_action with pending_action_id.',
          },
        }
      }

      // Fresh — stage it, don't mutate yet. The id is generated here rather
      // than read back from the insert so the row can be referenced in the
      // returned payload without a second round trip (confirm_pending_action
      // takes it as its only argument).
      const pendingActionId = randomUUID()

      // PHASE 3 (Part E) supersession: this args_key is fresh, but if it
      // targets the SAME conversation/booking as an already-staged,
      // not-yet-confirmed row for this same tool, that older row is a
      // stale draft of the thing being staged now (a refinement changes
      // args_key every time, by design — args must stay immutable once
      // shown for confirmation). Retire it explicitly rather than leaving
      // it to expire silently: its args/summary are untouched, only
      // cancelled_at + superseded_by are written, so the original draft
      // stays in the audit trail. See stableArgsKey/describePendingAction
      // above for why args can't just be mutated in place instead.
      //
      // Runs BEFORE claim acquisition below: a stale row's execution claim
      // (if any) is released here first, so the new claim acquisition never
      // has to fight the old one for authority over the same conversation.
      const targetKey = extractTargetKey(args as Record<string, unknown>)
      if (targetKey) {
        let staleQuery = supabase
          .from('caye_pending_actions')
          .select('id, args, execution_claim_id')
          .eq('workspace_id', ctx.workspaceId)
          .eq('tool_name', tool.name)
          .is('executed_at', null)
          .is('cancelled_at', null)
          .gt('expires_at', nowISO)
        staleQuery =
          approvalOperatorId != null
            ? staleQuery.eq('operator_id', approvalOperatorId)
            : staleQuery.is('operator_id', null)
        const { data: candidates } = await staleQuery
        const stale = (candidates ?? []).filter(
          (row) => extractTargetKey(row.args as Record<string, unknown>) === targetKey
        )
        for (const row of stale) {
          if (row.execution_claim_id) {
            await releaseConversationExecution(row.execution_claim_id as string).catch(() => undefined)
          }
          await supabase
            .from('caye_pending_actions')
            .update({ cancelled_at: nowISO, superseded_by: pendingActionId })
            .eq('id', row.id as string)
        }
      }

      // Staging an operator-directed customer reply is meaningful active
      // work, not merely a UI draft. Acquire the shared conversation claim
      // now so an autonomous webhook cannot independently answer while the
      // operator is reviewing/refining this exact thread.
      //
      // Keyed to THIS pending action, not to (operator, conversation): that
      // pair recurs forever — every future draft this operator ever stages
      // on this same conversation — and conversation-execution treats a
      // completed claim for a given key as permanently final, which would
      // make every draft after the FIRST successful send permanently
      // unclaimable. A fresh key per pending action means each draft always
      // gets a clean acquisition; any stale row's claim was already
      // released just above.
      let executionClaimId: string | null = null
      if (tool.name === 'send_reply' && typeof (args as Record<string, unknown>).conversation_id === 'string') {
        const conversationId = (args as Record<string, unknown>).conversation_id as string
        const execution = await claimConversationExecution({
          workspaceId: ctx.workspaceId,
          conversationId,
          holder: 'operator_caye',
          idempotencyKey: `operator-draft:${pendingActionId}`,
          reason: 'operator-directed Caye draft awaiting confirmation',
          leaseSeconds: ttlMinutes * 60,
        })
        if (!execution.ok) {
          return { ok: false, status: 'CONFLICT', error: `This customer conversation is currently owned by ${execution.blockedBy}; reload it before drafting a reply.` }
        }
        executionClaimId = execution.claim.id
      }

      const { error } = await supabase.from('caye_pending_actions').insert({
        id: pendingActionId,
        workspace_id: ctx.workspaceId,
        operator_id: approvalOperatorId,
        tool_name: tool.name,
        args,
        args_key: argsKey,
        summary,
        created_in_request_id: ctx.requestId,
        expires_at: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
        execution_claim_id: executionClaimId,
      })
      if (error) {
        if (executionClaimId) await releaseConversationExecution(executionClaimId).catch(() => undefined)
        return { ok: false, error: `Could not stage this action: ${error.message}` }
      }

      if (decisionDomain && decisionAuthority && !decisionAuthority.actorAuthorized) {
        const routed = await routeBusinessDecision({
          ctx,
          domain: decisionDomain,
          risk: 'high',
          subjectKey: decisionSubjectKey([tool.name, argsKey]),
          summary,
          resolution: decisionAuthority,
          evidence: { source: 'high_risk_gate', toolName: tool.name, argsKey, pendingActionId },
        })
        return { ...routed.result, data: { ...(routed.result.data as Record<string, unknown> ?? {}), pending_action_id: pendingActionId, summary } }
      }

      return {
        ok: true,
        data: {
          pending: true,
          executed: false,
          status: 'awaiting_operator_confirmation',
          pending_action_id: pendingActionId,
          summary,
          expires_in_minutes: ttlMinutes,
          note:
            'NOTHING HAS BEEN SENT OR CHANGED YET — do not tell the operator otherwise. ' +
            'Relay this summary VERBATIM: for a send_reply it already contains the full draft, ' +
            'so show that and ask ONE confirmation question ("Send that?"). Do not re-draft it in ' +
            'your own words and do not ask twice. When they approve in a NEW message, call ' +
            'confirm_pending_action with pending_action_id — NOT this tool again. Re-calling this ' +
            'tool only matches if your arguments are byte-identical, so any rewording silently ' +
            'stages a SECOND action instead of running this one.',
        },
      }
    },
  } as Tool<T>
}
