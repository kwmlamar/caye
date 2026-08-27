import 'server-only'
import { createHash } from 'crypto'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool, ToolContext, ToolMode } from './tools/types'
import {
  classifyError,
  normalizeResult,
  type ToolResult,
  type ToolStatus,
} from './tools/result'

/**
 * orchestrator.ts
 *
 * The layer between the model and tool execution. Owns retries, error
 * classification, verification and logging so the model owns none of them.
 *
 * WHY (2026-08-11)
 * runToolLoop used to call tool.execute inside a bare try/catch, stringify
 * whatever came back, and hand it to the model. Every recovery decision was
 * therefore a language-model judgement call made from a prose error string.
 * Asked to add an internal note, Caye hit an error and decided the right
 * response was to tell the owner to write it down herself.
 *
 * Recovery is mechanical. It belongs here.
 */

/**
 * Attempt budgets by risk tier.
 *
 * Reads retry freely — worst case is a wasted round trip.
 * Low-risk writes retry once: a FAILED_RETRYABLE write overwhelmingly means
 * the database was unreachable, so nothing was committed and a duplicate is
 * unlikely; losing the operator's work is the worse outcome.
 * High-risk writes never retry. Cancelling a booking or charging a card twice
 * is worse than reporting a failure, and these already sit behind a human
 * confirmation gate that a person can simply repeat.
 */
const MAX_ATTEMPTS: Record<string, number> = { read: 3, low: 2, high: 1 }

/** Small, bounded backoff — this runs inside a live WhatsApp turn. */
const RETRY_DELAY_MS = 400

export interface OrchestratedResult {
  /** Final result after retries, normalized to the taxonomy. */
  result: ToolResult
  attempts: number
  durationMs: number
}

/**
 * Deterministic per (turn, tool, arguments).
 *
 * Two identical calls within one turn are the same intent, so a tool that
 * consults this cannot double-write when the model repeats itself. Exposed
 * on ToolContext so tools with external side effects can thread it through
 * to the system they're calling.
 */
export function operationKey(
  requestId: string,
  toolName: string,
  args: unknown
): string {
  const canonical = stableStringify(args)
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  return `${requestId}:${toolName}:${digest}`
}

/** Key-sorted JSON so argument order can't change the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(',')}}`
}

/**
 * Execute one tool with classification, bounded retry, and structured logging.
 *
 * Never throws — a thrown error becomes a classified ToolResult, because the
 * caller is a live conversation turn and an exception there is silence on a
 * paying customer's phone.
 */
export async function runToolWithRecovery(
  tool: Tool<never>,
  args: unknown,
  ctx: ToolContext,
  meta: { mode: ToolMode; toolUseId?: string }
): Promise<OrchestratedResult> {
  const startedAt = Date.now()
  // Saving an external draft is the one high-risk write that can safely retry
  // when the tool itself proves the provider rejected it before creation.
  // Ambiguous failures stay at one attempt; duplicate drafts are worse than a
  // blocked work item.
  const budget = tool.name === 'draft_in_inbox' ? 2 : (MAX_ATTEMPTS[tool.risk] ?? 1)
  const scopedCtx: ToolContext = {
    ...ctx,
    operationKey: operationKey(ctx.requestId, tool.name, args),
  }

  let last: ToolResult = {
    ok: false,
    status: 'FAILED_PERMANENT',
    error: 'Tool did not run',
    error_code: 'NOT_EXECUTED',
  }
  let attempts = 0

  for (let attempt = 1; attempt <= budget; attempt++) {
    attempts = attempt
    try {
      const raw = await tool.execute(args as never, scopedCtx)
      last = normalizeResult(raw, `${toScreamingSnake(tool.name)}_FAILED`)
    } catch (err) {
      last = classifyError(err, `${toScreamingSnake(tool.name)}_THREW`)
      console.error(`[orchestrator] ${tool.name} threw (attempt ${attempt}/${budget}):`, last.error)
    }

    if (last.status !== 'FAILED_RETRYABLE') break
    if (attempt < budget) await sleep(RETRY_DELAY_MS * attempt)
  }

  const durationMs = Date.now() - startedAt
  void logToolCall({ tool, args, ctx: scopedCtx, meta, result: last, attempts, durationMs }).catch(
    (err) => console.error('[orchestrator] tool-call log write failed:', err)
  )

  return { result: last, attempts, durationMs }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toScreamingSnake(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()
}

/**
 * Fire-and-forget. A logging failure must never affect the reply — same
 * contract as lib/llm-telemetry.ts.
 */
async function logToolCall(entry: {
  tool: Tool<never>
  args: unknown
  ctx: ToolContext
  meta: { mode: ToolMode; toolUseId?: string }
  result: ToolResult
  attempts: number
  durationMs: number
}): Promise<void> {
  await recordToolCall({
    workspaceId: entry.ctx.workspaceId,
    requestId: entry.ctx.requestId,
    operatorId: entry.ctx.operatorId ?? null,
    callerRole: entry.ctx.callerRole,
    mode: entry.meta.mode,
    toolName: entry.tool.name,
    risk: entry.tool.risk,
    status: entry.result.status ?? 'SUCCESS',
    errorCode: entry.result.error_code ?? null,
    error: entry.result.error ?? null,
    attempts: entry.attempts,
    deferred: entry.result.deferred === true,
    durationMs: entry.durationMs,
    investigationId: entry.ctx.investigationId ?? null,
    toolUseId: entry.meta.toolUseId ?? null,
    args: entry.args,
  })
}

export interface ToolCallRecord {
  workspaceId: string | null
  requestId: string | null
  operatorId?: number | null
  callerRole?: string | null
  mode: string
  toolName: string
  risk?: string | null
  status: ToolStatus
  errorCode?: string | null
  error?: string | null
  attempts?: number
  deferred?: boolean
  durationMs?: number | null
  /** See caye_tool_calls.investigation_id — groups calls across a multi-turn investigation. */
  investigationId?: string | null
  /** The tool_use block id — joins back to the raw tool_result in caye_operator_messages. */
  toolUseId?: string | null
  /** Tool call arguments, for identifying which record a finding is about. */
  args?: unknown
}

/**
 * Write one row to caye_tool_calls.
 *
 * Takes primitives rather than a registry Tool so the front-desk path can use
 * it too (2026-08-12). Front-desk tools live as inline branches in
 * lib/caye-reply.ts rather than as registered Tool objects — the cross-registry
 * unification is issue #14 and has not happened — but the reason this table
 * exists applies to them at least as strongly: add_internal_note failed on
 * every call for weeks with the only trace being Caye apologising in a
 * transcript, and the customer-facing path has exactly the same blind spot.
 *
 * Never throws.
 */
export async function recordToolCall(entry: ToolCallRecord): Promise<void> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('caye_tool_calls').insert({
      workspace_id: entry.workspaceId,
      request_id: entry.requestId,
      operator_allowlist_id: entry.operatorId ?? null,
      caller_role: entry.callerRole ?? null,
      mode: entry.mode,
      tool_name: entry.toolName,
      risk: entry.risk ?? null,
      status: entry.status,
      error_code: entry.errorCode ?? null,
      error: entry.error ? entry.error.slice(0, 500) : null,
      attempts: entry.attempts ?? 1,
      deferred: entry.deferred === true,
      duration_ms: entry.durationMs ?? null,
      investigation_id: entry.investigationId ?? null,
      tool_use_id: entry.toolUseId ?? null,
      args: entry.args === undefined ? null : entry.args,
    })
    if (error) console.error('[orchestrator] caye_tool_calls insert failed:', error.message)
  } catch (err) {
    console.error('[orchestrator] caye_tool_calls insert threw:', err)
  }
}

/**
 * Plain-language instruction for the model, derived from the outcome.
 *
 * Deliberately prescriptive. Left to its own devices with a failed write the
 * model has already been observed handing the job back to the owner; this
 * says what to do instead, in the words to do it in.
 */
export function guidanceFor(
  status: ToolStatus | undefined,
  deferred: boolean,
  toolName?: string,
  errorCode?: string
): string | null {
  if (deferred) {
    return 'Saved. Confirm it is done and mention only that the calendar will catch up shortly. Do not ask the operator to record anything.'
  }
  if (
    toolName === 'draft_in_inbox' &&
    (status === 'FAILED_RETRYABLE' || status === 'FAILED_PERMANENT' || status === 'NEEDS_HUMAN')
  ) {
    return draftInInboxFailureGuidance(errorCode)
  }
  switch (status) {
    case 'SUCCESS':
    case undefined:
      return null
    case 'FAILED_RETRYABLE':
    case 'FAILED_PERMANENT':
      return 'This did not save. Say plainly that it did not go through and that you are on it. Never ask the operator to do it themselves, and never repeat error text.'
    case 'NOT_FOUND':
      return 'The record was not found. Ask which one they meant rather than guessing.'
    case 'CONFLICT':
      return 'This already exists. Say so and confirm the existing one instead of creating a second.'
    case 'NEEDS_HUMAN':
      return 'A connection needs re-authorising. Say what is disconnected in plain words and offer to walk them through reconnecting.'
  }
}

/**
 * draft_in_inbox-specific failure guidance, keyed by the tool's own
 * error_code rather than the coarser ToolStatus (CAY-139, 2026-08-26).
 *
 * WHY THIS EXISTS
 * Before this, every draft_in_inbox failure — rate-limited, auth-blocked,
 * deterministically rejected, and genuinely ambiguous (provider never
 * confirmed) — got the SAME generic "blocked or uncertain" sentence. Left
 * that vague, the model filled the gap itself: a live Bimini incident
 * (2026-08-26, this ticket) had it telling the owner "the staging system is
 * down" / "backend issue" / implying TropiTech should be notified — none of
 * which any tool result ever said. This function is the fix at the layer
 * where that happened: give the model the true, narrow, evidence-backed
 * reason for each error_code so there is no gap left to improvise into.
 * The 'unsupported-outage-claim' rule in action-claim-guard.ts is the code
 * backstop underneath this in case the model ignores it anyway.
 */
function draftInInboxFailureGuidance(errorCode?: string): string {
  const commonBan =
    'Never describe this as a system outage, a backend problem, or a bug, and never say anyone was notified or flagged about it unless a tool result actually says so.'
  switch (errorCode) {
    case 'ZOHO_DRAFT_RATE_LIMITED':
      return (
        'The email provider temporarily rejected this save (rate limited) — nothing was created. Preserve the ' +
        `completed draft text and say plainly it has not saved yet; a fresh attempt is safe since nothing was created. ${commonBan}`
      )
    case 'ZOHO_DRAFT_AUTH_REQUIRED':
      return (
        'The email connection is not authorised — nothing was created and retrying will not fix it. Preserve the ' +
        `completed draft text and tell the operator plainly that the email connection needs to be reconnected. ${commonBan}`
      )
    case 'ZOHO_DRAFT_MODE_NOT_VERIFIED':
      return (
        'Saving drafts to the inbox has not been safety-verified on this workspace yet — nothing was created. ' +
        'Preserve the completed draft text and say plainly this cannot be saved to the inbox yet; only the founder ' +
        `running the one-time verification unblocks it. ${commonBan}`
      )
    case 'ZOHO_DRAFT_CREATION_UNCERTAIN':
    case 'ZOHO_DRAFT_ID_MISSING':
      return (
        'The email provider did not confirm whether the draft was created — it may or may not exist. Preserve the ' +
        'completed draft text. Say plainly that you are not sure whether it saved and that you deliberately did not ' +
        `retry, to avoid creating a duplicate. Do NOT say it failed, and do NOT offer to send it instead. ${commonBan}`
      )
    default:
      return (
        'The requested email draft is blocked or uncertain. Preserve the completed draft text. Do NOT retry blindly, ' +
        `do NOT offer to send it instead, and do not turn this into a manual-copy request. ${commonBan}`
      )
  }
}
