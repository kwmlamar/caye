import 'server-only'
import { randomUUID } from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { createServiceClient } from '@/lib/supabase-server'
import { cayeAgent, type CayeAgentResult } from './index'

type SupabaseClient = ReturnType<typeof createServiceClient>

/**
 * investigation.ts
 *
 * Bounded, automatic continuation for founder-authorized investigations
 * that outgrow one runToolLoop invocation — built in direct response to
 * the 2026-08-17 Bimini revenue-audit incident.
 *
 * WHAT HAPPENED
 * The founder asked for a comprehensive multi-customer revenue audit.
 * Caye opened with 20 tool calls in one round, burned all
 * MAX_TOOL_ITERATIONS (execute.ts) on that and three more oversized
 * rounds, and hit the loop's degrade fallback before ever synthesizing an
 * answer. When the founder followed up in the same thread, the NEW turn
 * reloaded thread history through loadDirectThreadContext, which runs
 * every persisted turn through history-compaction.ts's 8000-byte verbatim
 * budget — nowhere near enough for ~50 tool_result blocks from the failed
 * attempt. Only the last couple of (smallest, newest) results survived;
 * the rest replayed as the elided placeholder. Caye described this to the
 * founder as "a platform-side caching issue" (wrong — it's this app's own
 * context-size management, lib/caye-agent/history-compaction.ts, nowhere
 * near Anthropic or any platform layer) and asked whether to retry —
 * despite the founder having already authorized the investigation, and
 * despite the elided note itself saying "re-run the tool if you need it
 * again."
 *
 * THE FIX
 * Two structural changes, not a rewrite of the agent loop:
 *
 *  1. Every tool call already gets logged to caye_tool_calls
 *     (orchestrator.ts). It now also records investigation_id, tool_use_id,
 *     and args — durable, queryable provenance for every finding,
 *     independent of what a later turn's compacted replay can show the
 *     model. See the 20260817 migration.
 *
 *  2. When runToolLoop reports ranOutOfIterations (it burned its budget
 *     without a final answer), the caller — founder-thread-turn.ts —
 *     automatically re-invokes cayeAgent with the SAME investigationId,
 *     bounded by MAX_INVESTIGATION_CONTINUATIONS below. The continuation's
 *     starting context is NOT the compacted thread replay; it's
 *     summarizeInvestigation()'s deterministic digest of every tool call
 *     made so far, built straight from caye_tool_calls. This sidesteps
 *     history-compaction.ts entirely for the one case where it was
 *     actually a problem (a single logical task spread across several
 *     internal round-trips) without changing it at all for everything else
 *     it exists to solve (real multi-day thread replay cost).
 *
 * This is deliberately NOT a general "resumable agent" framework. It
 * exists to let one authorized investigation keep going past one
 * runToolLoop invocation's iteration budget, grounded in what actually
 * happened rather than a best-effort guess. The founder is asked again
 * only when MAX_INVESTIGATION_CONTINUATIONS is exhausted, and even then
 * with a real summary of what was found — never a bare "try again?".
 *
 * WHERE THE REAL DATA LIVES
 * caye_tool_calls (and this module's digest of it) never stores or repeats
 * tool_result CONTENT — only that a call happened, on what, and whether it
 * succeeded. The authoritative content is, and stays, the tool_result block
 * itself, persisted verbatim in caye_operator_messages.claude_format for
 * the pass that produced it (never mutated — history-compaction.ts only
 * ever affects what gets REPLAYED into a later turn's context, not what's
 * stored). A continuation that needs the actual figures a prior pass
 * gathered re-calls the same tool with the same arguments — cheap,
 * idempotent for every read tool in this registry, and the one thing that
 * cannot silently drift into a fabricated number the way trusting a
 * digest's own prose could.
 *
 * WRITES ARE STRUCTURALLY EXCLUDED FROM CONTINUATIONS
 * runToolLoop's `readOnly` flag (see execute.ts) is set on every
 * continuation pass — the tool schemas shipped to the model exclude every
 * low/high-risk tool entirely, so a continuation cannot duplicate a write
 * even if the model tried to. This is a structural guarantee (the tool
 * isn't offered), not a prompt instruction the model has to remember.
 */

/**
 * Hard ceiling on internal continuations. Combined with
 * MAX_TOOL_ITERATIONS (5) and MAX_TOOL_CALLS_PER_ROUND (10) in execute.ts,
 * this bounds one investigation to at most
 * (1 + MAX_INVESTIGATION_CONTINUATIONS) × MAX_TOOL_ITERATIONS × MAX_TOOL_CALLS_PER_ROUND
 * = 5 × 5 × 10 = 250 tool calls before Caye is required to stop and return
 * to the founder — generous for a real business audit, finite by
 * construction so a stuck loop cannot run forever on its own authority.
 */
export const MAX_INVESTIGATION_CONTINUATIONS = 4

interface ToolCallLedgerRow {
  tool_name: string
  status: string
  deferred: boolean | null
  args: unknown
  created_at: string
}

export interface InvestigationDigest {
  /** Total tool calls recorded for this investigation_id so far. */
  totalCalls: number
  /** Rendered, ready to drop into a continuation prompt. Empty string if nothing was found (e.g. a fresh investigation_id). */
  summaryText: string
  /** Every subject (from succeeded, non-deferred calls only) already covered — for tests, and for a future caller that wants the raw list rather than the rendered text. */
  coveredSubjects: string[]
}

/**
 * Deterministic digest of everything recorded under one investigation_id —
 * NOT model-authored, so it can't drift from what actually happened. Built
 * straight from caye_tool_calls, which is written as each tool executes
 * (orchestrator.ts), so it reflects the full investigation even when the
 * loop that gathered it never reached a final answer.
 *
 * Scoped to `workspaceId` as well as `investigationId` — defense in depth.
 * A cryptographically random investigationId can't practically collide
 * across workspaces, but a digest is context that gets billed straight into
 * a live model call, so this never trusts a single global key alone to keep
 * one workspace's business data out of another's investigation.
 *
 * Deliberately does NOT store or surface tool_result *content* — only what
 * was called, on what, and whether it succeeded. That's what keeps this a
 * mechanical record instead of a second, less-trustworthy copy of "the
 * facts": a continuation that needs the actual data calls the tool again
 * (cheap, idempotent, and the authoritative source — see the module doc
 * comment's "WHERE THE REAL DATA LIVES" note) rather than trusting a
 * digest line to already contain it.
 */
export async function summarizeInvestigation(
  supabase: SupabaseClient,
  investigationId: string,
  workspaceId: string
): Promise<InvestigationDigest> {
  const { data, error } = await supabase
    .from('caye_tool_calls')
    .select('tool_name, status, deferred, args, created_at')
    .eq('investigation_id', investigationId)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })

  if (error || !data || data.length === 0) {
    return { totalCalls: 0, summaryText: '', coveredSubjects: [] }
  }

  const rows = data as ToolCallLedgerRow[]
  const byTool = new Map<
    string,
    { ok: number; deferred: number; failed: number; okSubjects: Set<string>; deferredSubjects: Set<string>; failedSubjects: Set<string> }
  >()
  for (const row of rows) {
    const entry =
      byTool.get(row.tool_name) ??
      { ok: 0, deferred: 0, failed: 0, okSubjects: new Set(), deferredSubjects: new Set(), failedSubjects: new Set() }
    const subject = describeArgs(row.args)
    // Never blend a failure's identifier into the same list as a success's
    // — a model reading "39 succeeded, 1 failed (e.g. conv-1, conv-99)"
    // cannot tell which one is which. Each status gets its own subject set.
    if (row.status === 'SUCCESS' && row.deferred === true) {
      entry.deferred += 1
      if (subject) entry.deferredSubjects.add(subject)
    } else if (row.status === 'SUCCESS') {
      entry.ok += 1
      if (subject) entry.okSubjects.add(subject)
    } else {
      entry.failed += 1
      if (subject) entry.failedSubjects.add(subject)
    }
    byTool.set(row.tool_name, entry)
  }

  const lines: string[] = []
  const coveredSubjects: string[] = []
  for (const [toolName, entry] of byTool) {
    const parts = [`${entry.ok} succeeded`]
    if (entry.deferred > 0) parts.push(`${entry.deferred} saved locally, pending external sync`)
    if (entry.failed > 0) parts.push(`${entry.failed} failed`)
    let line = `- ${toolName}: ${parts.join(', ')}`
    // Full coverage list, not a truncated sample — an audit spanning dozens
    // of records needs the model to know EXACTLY which ones it already has,
    // not "e.g. 5 of them," or it can't tell what's actually still missing.
    // These are short identifiers (ids/names the model itself supplied as
    // tool input), not raw business data, so there is no meaningful size
    // concern at realistic investigation scale.
    if (entry.okSubjects.size > 0) {
      const subjects = [...entry.okSubjects]
      line += `. Already covered (do not re-fetch): ${subjects.join(', ')}`
      coveredSubjects.push(...subjects)
    }
    if (entry.failedSubjects.size > 0) {
      line += `. FAILED for: ${[...entry.failedSubjects].join(', ')} — do not report these as covered.`
    }
    if (entry.deferredSubjects.size > 0) {
      line += `. Saved locally pending sync for: ${[...entry.deferredSubjects].join(', ')}.`
    }
    lines.push(line)
  }

  return {
    totalCalls: rows.length,
    summaryText: lines.join('\n'),
    coveredSubjects,
  }
}

/** Best-effort one-line identifier for what a call was about, from its recorded args. */
function describeArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  const idish = obj.conversation_id ?? obj.customer_id ?? obj.contact_id ?? obj.query ?? obj.name
  return typeof idish === 'string' ? idish : null
}

/**
 * The synthetic turn a continuation opens with — replaces the compacted
 * thread replay entirely for this one internal call. Repeats the founder's
 * original objective verbatim so the continuation can't drift onto a
 * different task, and states plainly that this is an authorized resumption,
 * not a new request needing permission.
 */
export function buildContinuationPrompt(objective: string, digest: InvestigationDigest): string {
  const lines = [
    'CONTINUING AN INVESTIGATION YOU ALREADY STARTED AND WERE ALREADY AUTHORIZED TO RUN.',
    '',
    `Original request: ${objective}`,
    '',
  ]
  if (digest.totalCalls > 0) {
    lines.push(
      `You already made ${digest.totalCalls} tool call(s) toward this before running out of room ` +
        `to keep going in one round. Here is exactly what was already called and what happened — this ` +
        `is a complete, mechanical record, not a sample:`,
      '',
      digest.summaryText,
      '',
      "Do not re-fetch anything listed above as already covered — that's wasted rounds you don't have " +
        'unlimited copies of. Do fetch anything listed as FAILED again if it still matters, and anything ' +
        'genuinely not listed yet. If you need the actual DETAILS behind an already-covered result again ' +
        '(not just the fact that it succeeded — this digest deliberately does not repeat that content), ' +
        'call that same tool with the same arguments once to get it back; that is expected, not a sign ' +
        'anything went wrong.'
    )
  }
  lines.push(
    '',
    'Keep going from here. Do not start over. Do not ask whether to continue — the founder already ' +
      "authorized this investigation; running out of room in one round is routine, not a failure that " +
      'needs their permission to recover from. Only tools that read data are available on this pass — ' +
      'that is intentional, not a malfunction; nothing that changes anything needs to happen to finish ' +
      'this. Only stop and return to the founder once you have a real answer, need a decision only they ' +
      'can make, or have genuinely confirmed something is inaccessible after trying.'
  )
  return lines.join('\n')
}

/**
 * The founder-facing message once MAX_INVESTIGATION_CONTINUATIONS is
 * exhausted without a real synthesis — twin of buildContinuationPrompt
 * above (same digest input, same investigation-state concern), grounded in
 * what was actually found rather than a generic "try again?" placeholder.
 */
export function buildExhaustionSummary(digest: InvestigationDigest, passes: number): string {
  return [
    `This investigation ran ${digest.totalCalls} tool calls across ${passes} passes ` +
      "and hit the amount I'll run on my own before checking back with you.",
    digest.totalCalls > 0
      ? `Here's what I actually confirmed before stopping:\n\n${digest.summaryText}`
      : "I wasn't able to confirm anything before stopping.",
    'Nothing here is invented — this is only what the tools actually returned. Want me to keep going from here, or write up the analysis from what I have so far?',
  ].join('\n\n')
}

export interface RunInvestigationInput {
  workspaceId: string
  threadId: string
  message: string
  callerName: string
  operatorId: number | null
  engineeringOrigin?: { threadId: string; messageId: string }
}

/**
 * Runs one founder-authorized investigation end to end: the initial
 * cayeAgent() pass, bounded automatic continuation while runToolLoop keeps
 * reporting ranOutOfIterations (see the module doc comment above), and —
 * only once the continuation budget is exhausted — a real, ledger-grounded
 * summary in place of the generic per-round degrade placeholder.
 *
 * `persistPassTurns` is supplied by the caller (founder-thread-turn.ts) so
 * each pass's turns land in caye_operator_messages immediately rather than
 * accumulating in memory across a possibly multi-pass investigation — see
 * that caller's own comment on why that bounds crash-loss to one in-flight
 * pass instead of the whole investigation.
 */
export async function runInvestigation(
  supabase: SupabaseClient,
  input: RunInvestigationInput,
  persistPassTurns: (turns: Anthropic.MessageParam[], linkedThreadIds: string[], engineeringArtifactIds?: string[]) => Promise<void>
): Promise<CayeAgentResult> {
  // Generated once, up front, and reused for every continuation of this
  // same logical investigation — this is the key that
  // caye_tool_calls.investigation_id groups on and that
  // summarizeInvestigation() reads back. Never returned to the caller —
  // nothing outside this function can address or resume a specific
  // investigation, which is what makes "two workers racing the same
  // investigation" structurally impossible today: there is no channel
  // through which a second process could ever learn this id.
  const investigationId = randomUUID()

  let agentResult: CayeAgentResult = await cayeAgent({
    mode: 'back-office',
    workspaceId: input.workspaceId,
    userMessage: input.message,
    callerRole: 'founder',
    callerName: input.callerName,
    operatorId: input.operatorId,
    threadId: input.threadId,
    investigation: { id: investigationId, isContinuation: false, objective: input.message },
    engineeringOrigin: input.engineeringOrigin,
  })
  await persistPassTurns(agentResult.newTurns, agentResult.linkedThreadIds, agentResult.engineeringArtifactIds)

  // A recoverable "ran out of room in one round" is never surfaced to the
  // founder as a question — the founder already authorized this
  // investigation by asking for it. Only when MAX_INVESTIGATION_CONTINUATIONS
  // is exhausted does this return a real, ledger-grounded status instead of
  // silently repeating the generic "taking longer" placeholder.
  let continuations = 0
  while (agentResult.ranOutOfIterations && continuations < MAX_INVESTIGATION_CONTINUATIONS) {
    continuations++
    agentResult = await cayeAgent({
      mode: 'back-office',
      workspaceId: input.workspaceId,
      userMessage: input.message,
      callerRole: 'founder',
      callerName: input.callerName,
      operatorId: input.operatorId,
      threadId: input.threadId,
      investigation: { id: investigationId, isContinuation: true, objective: input.message },
    })
    await persistPassTurns(agentResult.newTurns, agentResult.linkedThreadIds, agentResult.engineeringArtifactIds)
  }

  if (agentResult.ranOutOfIterations) {
    const digest = await summarizeInvestigation(supabase, investigationId, input.workspaceId)
    const groundedText = buildExhaustionSummary(digest, continuations + 1)
    const finalTurn: Anthropic.MessageParam = { role: 'assistant', content: [{ type: 'text', text: groundedText }] }
    await persistPassTurns([finalTurn], [])
    agentResult = { ...agentResult, replyText: groundedText }
  }

  return agentResult
}
