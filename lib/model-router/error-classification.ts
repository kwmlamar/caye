import 'server-only'
import type { ClassifiedError } from './types'

/**
 * Distinguishes "safe to retry the same turn on the next backend" from
 * "stop and tell Lamar" per the fallback-vs-side-effect rule (see the
 * multi-model router brief, section 7):
 *
 * Fallback is fine for: exhausted subscription quota, rate limits,
 * transient provider errors, a missing/unreachable CLI, expired auth that
 * can't silently refresh, capability mismatch.
 *
 * Fallback must NOT happen after: a tool call in this turn may have had a
 * side effect (dispatched a message, staged a booking write), an
 * authorization failure, or a malformed request — those are Lamar's or
 * Caye's problem to see, not paper over with a different model.
 *
 * IMPORTANT: this only classifies whether the *reasoning* call may be
 * retried against another backend. It says nothing about tool-level
 * idempotency — that's lib/caye-agent/orchestrator.ts's operationKey and
 * dispatchOperatorReply's triggeringMessageId, reused unchanged. See
 * router.ts's `sideEffectOccurred` guard for how the two combine.
 */
export interface RawBackendError {
  /** Provider-specific status/code if known, e.g. HTTP status or CLI exit code. */
  httpStatus?: number
  exitCode?: number
  message: string
  /** True if this error came from spawning/finding the CLI binary itself, not from the model. */
  clientMissing?: boolean
  /** True if the provider's own response says auth/session is invalid and can't be silently refreshed. */
  authExpired?: boolean
  /**
   * Set by a backend (once tool bridging lands — see router.ts's doc
   * comment) when a tool call with an external side effect may have run
   * before the error was thrown. Checked first: no other signal overrides
   * this, because the cost of silently duplicating a sent message or a
   * booking write is worse than the cost of an extra manual retry.
   */
  sideEffectOccurred?: boolean
  /**
   * Set explicitly by a CLI backend that parsed a provider-native
   * quota/usage-limit event out of its own structured output (see
   * openai-codex-subscription.ts's extractCodexFailureMessage) rather than
   * inferring it from an HTTP status this transport doesn't have.
   */
  quotaExhausted?: boolean
}

/**
 * Live-observed phrasing (2026-08-16, real Codex CLI quota exhaustion
 * during local testing): "You've hit your usage limit. Upgrade to Pro
 * ... or try again at Aug 20th, 2026 4:38 PM." Matched independent of
 * httpStatus, since CLI transports don't have one — a message-only signal
 * from a subprocess is still a real signal.
 */
const QUOTA_MESSAGE_PATTERN = /usage limit|quota|insufficient (credits|quota)|purchase more credits|upgrade to (pro|plus)/i

export function classifyBackendError(err: RawBackendError): ClassifiedError {
  if (err.sideEffectOccurred) {
    return { fallback: false, reason: 'side_effect_may_have_occurred' }
  }
  if (err.quotaExhausted || QUOTA_MESSAGE_PATTERN.test(err.message)) {
    return { fallback: true, reason: 'quota_exhausted' }
  }
  if (err.clientMissing) {
    return { fallback: true, reason: 'client_unavailable' }
  }
  if (err.authExpired) {
    return { fallback: true, reason: 'auth_required' }
  }
  if (err.httpStatus === 401 || err.httpStatus === 403) {
    return { fallback: true, reason: 'auth_required' }
  }
  if (err.httpStatus === 429) {
    return { fallback: true, reason: 'rate_limited' }
  }
  // Anthropic/OpenAI both use 4xx quota/billing errors distinct from plain
  // rate limiting; the quota check above already caught quota-shaped 4xx
  // messages, so anything left in this range is a genuine request-shape
  // problem, not a provider outage.
  if (err.httpStatus && err.httpStatus >= 400 && err.httpStatus < 500) {
    return { fallback: false, reason: 'malformed_request' }
  }
  if (err.httpStatus && err.httpStatus >= 500) {
    return { fallback: true, reason: 'transient_provider_failure' }
  }
  // CLI subprocess exit codes: treat any nonzero exit without a captured
  // stdout/stderr classification above as a transient failure, not a
  // request problem — the CLI's own error taxonomy isn't ours to parse
  // reliably across versions.
  if (typeof err.exitCode === 'number' && err.exitCode !== 0) {
    return { fallback: true, reason: 'transient_provider_failure' }
  }
  return { fallback: true, reason: 'transient_provider_failure' }
}
