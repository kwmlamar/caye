import 'server-only'

/**
 * Machine-readable outcome taxonomy for tool execution.
 *
 * WHY THIS EXISTS (2026-08-11)
 * `ToolResult` was `{ ok, data?, error? }`. A failure carried a raw string and
 * nothing else, so the orchestrator had no way to tell "Zoho timed out, try
 * again in a second" apart from "that conversation id doesn't exist." Both
 * arrived as `ok: false` with prose, and the only actor capable of deciding
 * what to do next was the model — which decided, on 2026-08-11, to tell the
 * owner to write her own note down.
 *
 * Recovery is a property of the failure, not a judgement call. Classifying it
 * here means `runToolWithRecovery` can retry, defer, or escalate without
 * asking the model anything.
 */
export type ToolStatus =
  /** Completed and verified. */
  | 'SUCCESS'
  /** Transient — the same call may well work on the next attempt. */
  | 'FAILED_RETRYABLE'
  /** Broken in a way retrying cannot fix (bad input, schema violation). */
  | 'FAILED_PERMANENT'
  /** The addressed row/entity does not exist. */
  | 'NOT_FOUND'
  /** Would duplicate or contradict something that already exists. */
  | 'CONFLICT'
  /** Cannot proceed without a person (auth expired, ambiguous, policy). */
  | 'NEEDS_HUMAN'

/**
 * Structured tool output. Stringified into a `tool_result` block.
 *
 * `ok` is retained (rather than derived from `status`) because ~60 tools
 * predate this taxonomy and still return the bare `{ ok, error }` shape.
 * `normalizeResult` upgrades those on the way out, so both shapes coexist
 * without a flag-day rewrite of every tool.
 */
export interface ToolResult {
  ok: boolean
  status?: ToolStatus
  data?: unknown
  /** Short human-readable failure text. Operator-safe — no codes, no stack. */
  error?: string
  /**
   * Internal diagnostic code (`ZOHO_CALENDAR_CREATE_FAILED`, `PG_23505`).
   * Written to `caye_tool_calls`; deliberately NOT shipped to the model —
   * see stripForModel(). Item #12: internal vocabulary never reaches a human.
   */
  error_code?: string
  retryable?: boolean
  /**
   * Set when the intended effect was preserved locally but an external
   * system has not caught up yet — the note is stored, the calendar event
   * is queued. The operator's request DID land; only the mirror is behind.
   * This is the difference between "I saved it, calendar's catching up" and
   * "write it down yourself."
   */
  deferred?: boolean
  /**
   * Pre-written, operator-safe sentence describing the outcome. Present on
   * deferred/failed results so the model reports what happened without
   * inventing phrasing or leaking mechanism.
   */
  operator_message?: string
}

export function succeeded(data?: unknown): ToolResult {
  return { ok: true, status: 'SUCCESS', data }
}

export function failedRetryable(errorCode: string, error: string): ToolResult {
  return { ok: false, status: 'FAILED_RETRYABLE', error, error_code: errorCode, retryable: true }
}

export function failedPermanent(errorCode: string, error: string): ToolResult {
  return { ok: false, status: 'FAILED_PERMANENT', error, error_code: errorCode, retryable: false }
}

export function notFound(error: string): ToolResult {
  return { ok: false, status: 'NOT_FOUND', error, error_code: 'NOT_FOUND', retryable: false }
}

export function conflict(errorCode: string, error: string, data?: unknown): ToolResult {
  return { ok: false, status: 'CONFLICT', error, error_code: errorCode, retryable: false, data }
}

export function needsHuman(errorCode: string, error: string): ToolResult {
  return { ok: false, status: 'NEEDS_HUMAN', error, error_code: errorCode, retryable: false }
}

/**
 * The intended effect is safely persisted; an external mirror is pending.
 *
 * Reported as ok:true on purpose. From the operator's side the thing she
 * asked for HAS happened — the record exists, it will show up in the
 * dashboard, and a worker owns getting it to Zoho. Reporting this as a
 * failure is what produced "jot it down on your end for now."
 */
export function deferred(data: unknown, operatorMessage: string): ToolResult {
  return {
    ok: true,
    status: 'SUCCESS',
    deferred: true,
    data,
    operator_message: operatorMessage,
  }
}

/** Postgres SQLSTATE classes we can act on without guessing. */
const PG_PERMANENT = new Set([
  '22P02', // invalid_text_representation — e.g. a bad enum literal
  '23502', // not_null_violation
  '23514', // check_violation
  '42703', // undefined_column
  '42P01', // undefined_table
  '42501', // insufficient_privilege
])

/**
 * Map an arbitrary thrown value or Supabase error onto the taxonomy.
 *
 * Conservative by construction: anything unrecognised is FAILED_RETRYABLE
 * with a single attempt budget rather than FAILED_PERMANENT. A needless retry
 * costs one HTTP round trip; a wrongly-permanent classification loses the
 * operator's work, which is the failure mode this whole module exists to end.
 */
export function classifyError(err: unknown, fallbackCode: string): ToolResult {
  const pg = err as { code?: string; message?: string } | null
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '')
  const message = raw || 'Unknown error'

  const pgCode = typeof pg?.code === 'string' ? pg.code : null
  if (pgCode) {
    if (pgCode === '23505') {
      return conflict(`PG_${pgCode}`, 'That already exists.')
    }
    if (pgCode === '23503') {
      return notFound('The record this refers to no longer exists.')
    }
    if (PG_PERMANENT.has(pgCode)) {
      return failedPermanent(`PG_${pgCode}`, message)
    }
    // 08xxx connection_exception, 40001 serialization_failure, 53xxx
    // insufficient_resources, 57xxx operator_intervention — all transient.
    if (/^(08|40|53|57)/.test(pgCode)) {
      return failedRetryable(`PG_${pgCode}`, message)
    }
  }

  const status = httpStatusFrom(message)
  if (status !== null) {
    if (status === 401 || status === 403) {
      return needsHuman(`HTTP_${status}`, 'That connection needs to be re-authorised.')
    }
    if (status === 404) return notFound('That record was not found in the connected system.')
    if (status === 409) return conflict(`HTTP_${status}`, 'That already exists.')
    if (status === 408 || status === 429 || status >= 500) {
      return failedRetryable(`HTTP_${status}`, message)
    }
    if (status >= 400) return failedPermanent(`HTTP_${status}`, message)
  }

  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network|timeout|aborted/i.test(message)) {
    return failedRetryable('NETWORK', message)
  }

  // Some upstream errors say the thing is gone without an HTTP code —
  // zoho-calendar.ts's ETAG lookup throws `event <id> no longer exists` after
  // a 404 (a732dd6). Retrying that six times cannot bring the event back.
  if (/no longer exists|not found|does not exist/i.test(message)) {
    return notFound(message)
  }

  return failedRetryable(fallbackCode, message)
}

/**
 * Pull a 3-digit HTTP status out of the messages the Zoho/Gmail helpers
 * throw (`... (HTTP 429, code ...)` / `... status: 401 ...`).
 *
 * Exported so draft-in-inbox.ts can reuse the exact same status-detection
 * this module already uses to classify PG/HTTP errors, instead of a second,
 * possibly-drifting regex — a null return there means "no explicit status
 * found," which is the signal that separates a deterministic provider
 * rejection from a genuinely ambiguous network/timeout failure.
 */
export function httpStatusFrom(message: string): number | null {
  // Three shapes seen in this codebase's thrown provider errors:
  //   zoho-calendar.ts:  "Zoho Calendar create failed (503): upstream"
  //   generic:           "... status: 401 ..."
  //   email-ai.ts:       "Zoho Mail API draft error (HTTP 400, code 400): ..."
  // (CAY-139, 2026-08-26) The third shape was previously unrecognised here —
  // draft-in-inbox.ts's deterministic-vs-ambiguous classification depends on
  // this function telling the two apart, so a real Zoho Mail 4xx/5xx was
  // silently falling into "no status found" (the ambiguous bucket) even
  // though Zoho had answered synchronously and definitely rejected it.
  const m =
    /\((\d{3})\)/.exec(message) ??
    /\bstatus[ :=]+(\d{3})\b/i.exec(message) ??
    /\bHTTP[ :]?(\d{3})\b/i.exec(message)
  if (!m) return null
  const n = Number(m[1])
  return n >= 100 && n <= 599 ? n : null
}

/**
 * Give a legacy `{ ok, error }` result a status so downstream code can rely
 * on the field being present. Existing tools keep returning what they always
 * returned; the orchestrator sees a complete taxonomy either way.
 *
 * A legacy failure is classified as FAILED_PERMANENT rather than retryable:
 * these are overwhelmingly validation/ownership rejections from _guards.ts,
 * and blindly retrying an unclassified write is the more dangerous default.
 */
export function normalizeResult(result: ToolResult, fallbackCode: string): ToolResult {
  if (result.status) return result
  if (result.ok) return { ...result, status: 'SUCCESS' }
  return {
    ...result,
    status: 'FAILED_PERMANENT',
    error_code: result.error_code ?? fallbackCode,
    retryable: false,
  }
}

/**
 * What the model is allowed to see.
 *
 * Drops `error_code` and `retryable` — internal mechanism the model has no
 * decision left to make about (the orchestrator already retried and deferred
 * before this point) and which has previously been repeated verbatim to
 * operators. Item #12.
 */
export function stripForModel(result: ToolResult): Record<string, unknown> {
  const out: Record<string, unknown> = { ok: result.ok, status: result.status }
  if (result.data !== undefined) out.data = result.data
  if (result.error) out.error = result.error
  if (result.deferred) out.saved_locally = true
  if (result.operator_message) out.tell_the_operator = result.operator_message
  return out
}
