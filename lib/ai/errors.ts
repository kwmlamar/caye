import 'server-only'
import { AIProviderError, type AIErrorCategory, type AIProviderId } from './types'

/**
 * Failover policy, expressed once as a table instead of as judgement
 * scattered through call sites.
 *
 * The rule: fail over for *availability* problems (the provider can't serve
 * anyone right now), never for *correctness* problems (the request itself is
 * broken). Sending an invalid tool schema to all three providers in sequence
 * just buys three identical 400s, three bills, and a slower error.
 */
export interface FailurePolicy {
  /** Try the next provider in the route. */
  failover: boolean
  /** Retry the SAME provider once, bounded, before failing over. */
  retrySameProvider: boolean
  /** Open the circuit breaker for this provider. */
  opensCircuit: boolean
  /** Cooldown when the circuit opens. */
  cooldownMs: number
  /** Consecutive failures required before the circuit opens. 1 = immediately. */
  failureThreshold: number
}

const MINUTE = 60_000

export const FAILURE_POLICY: Record<AIErrorCategory, FailurePolicy> = {
  // The Anthropic-out-of-credit case this whole gateway exists for. Long
  // cooldown: an exhausted balance does not fix itself in 60s, and retrying
  // it on every request just adds latency to every single Caye interaction.
  // Cleared early by a credential change — see health.ts.
  billing_exhausted: { failover: true, retrySameProvider: false, opensCircuit: true, cooldownMs: 30 * MINUTE, failureThreshold: 1 },
  // A bad/absent key is a config fact, not a blip.
  authentication: { failover: true, retrySameProvider: false, opensCircuit: true, cooldownMs: 30 * MINUTE, failureThreshold: 1 },
  quota: { failover: true, retrySameProvider: false, opensCircuit: true, cooldownMs: 10 * MINUTE, failureThreshold: 1 },
  rate_limit: { failover: true, retrySameProvider: true, opensCircuit: true, cooldownMs: MINUTE, failureThreshold: 3 },
  timeout: { failover: true, retrySameProvider: false, opensCircuit: true, cooldownMs: MINUTE, failureThreshold: 3 },
  network: { failover: true, retrySameProvider: false, opensCircuit: true, cooldownMs: MINUTE, failureThreshold: 3 },
  upstream_5xx: { failover: true, retrySameProvider: false, opensCircuit: true, cooldownMs: 2 * MINUTE, failureThreshold: 3 },

  // Deterministic, request-shaped failures. Caye's bug, not the provider's.
  malformed_request: { failover: false, retrySameProvider: false, opensCircuit: false, cooldownMs: 0, failureThreshold: 0 },
  invalid_tool_or_schema: { failover: false, retrySameProvider: false, opensCircuit: false, cooldownMs: 0, failureThreshold: 0 },
  // A refusal is a decision about the content, and the next model would very
  // likely make the same one. Failing over would also mean quietly shopping
  // for a provider willing to produce something the first one declined.
  content_policy: { failover: false, retrySameProvider: false, opensCircuit: false, cooldownMs: 0, failureThreshold: 0 },

  // Provider-specific incompatibilities. A different provider genuinely may
  // succeed (different window, different schema dialect), so these DO fail
  // over — but they never open a circuit, because the provider is healthy.
  context_length_exceeded: { failover: true, retrySameProvider: false, opensCircuit: false, cooldownMs: 0, failureThreshold: 0 },
  unsupported_capability: { failover: true, retrySameProvider: false, opensCircuit: false, cooldownMs: 0, failureThreshold: 0 },

  // Non-negotiable: a tool with an external side effect may already have run.
  // Re-running the turn on another provider risks a duplicate send/booking.
  side_effect_may_have_occurred: { failover: false, retrySameProvider: false, opensCircuit: false, cooldownMs: 0, failureThreshold: 0 },

  unknown: { failover: true, retrySameProvider: false, opensCircuit: true, cooldownMs: MINUTE, failureThreshold: 5 },
}

export function policyFor(category: AIErrorCategory): FailurePolicy {
  return FAILURE_POLICY[category]
}

/**
 * Live-observed phrasing, kept as evidence rather than guesswork:
 *
 * Anthropic returns HTTP **400** for an exhausted account —
 * `{"type":"invalid_request_error","message":"Your credit balance is too low
 * to access the Anthropic API..."}` (2026-08-31, 14 failed production
 * research runs). Classifying that as `malformed_request` would mark a
 * billing outage as a Caye bug and block failover — precisely the production
 * failure this gateway is built to survive. So the billing test runs BEFORE
 * the generic 4xx branch.
 */
const BILLING_PATTERN =
  /credit balance is too low|insufficient[_ ]?(credits|funds|balance)|billing|payment required|purchase (more )?credits|upgrade to (pro|plus)|exceeded your current quota|plan.{0,20}billing/i
const QUOTA_PATTERN = /usage limit|quota|rate of requests|too many requests|capacity/i
const CONTEXT_PATTERN =
  /context[_ ]length|maximum context|prompt is too long|too many tokens|reduce the length|input length and `max_tokens` exceed/i
const TOOL_SCHEMA_PATTERN = /tools\.\d|tool_use|input_schema|invalid schema|function.{0,20}parameters|json_schema/i
/**
 * Provider-specific *limits* that another provider may not have. These arrive
 * as HTTP 400s and read like "your request is broken", but they are not:
 *
 *   - `Invalid 'tools': array too long. Expected an array with maximum length
 *     128, but got an array with length 129` (OpenAI, observed in production
 *     2026-09-01 — the founder back-office surface is 129 tools). OpenRouter
 *     served the identical request; Anthropic had been serving it for months.
 *   - `Could not finish the message because max_tokens or model output limit
 *     was reached` (OpenAI reasoning models treat a small max_tokens as an
 *     error; Anthropic simply truncates).
 *
 * Classifying these as `malformed_request` made them terminal and killed the
 * whole failover chain on the first non-Anthropic provider, which is exactly
 * how a billing outage at one vendor took down Caye's operator path.
 */
const PROVIDER_LIMIT_PATTERN =
  /array too long|array_above_max_length|maximum length \d+|max_tokens or model output limit|too many (tools|functions)|number of (tools|functions)/i

const CONTENT_POLICY_PATTERN = /content[_ ]policy|safety|refus(al|ed)|moderation|flagged/i
const TIMEOUT_PATTERN = /timed? ?out|deadline exceeded|aborted/i
const NETWORK_PATTERN = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|terminated/i

interface ErrorFacts {
  message: string
  httpStatus?: number
  retryAfterMs?: number
  isAbort: boolean
}

function extract(error: unknown): ErrorFacts {
  if (error instanceof AIProviderError) {
    return { message: error.message, httpStatus: error.opts.httpStatus, retryAfterMs: error.opts.retryAfterMs, isAbort: false }
  }
  const e = (error ?? {}) as Record<string, unknown>
  const status = e.status ?? e.statusCode ?? e.httpStatus
  const headers = e.headers as Record<string, string> | undefined
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After']
  const nested = typeof e.error === 'object' && e.error ? (e.error as Record<string, unknown>) : undefined
  const nestedMessage = typeof nested?.message === 'string' ? nested.message : undefined
  const deepMessage =
    nested && typeof nested.error === 'object' && nested.error
      ? (nested.error as Record<string, unknown>).message
      : undefined
  return {
    message: [e.message, nestedMessage, deepMessage].filter((m) => typeof m === 'string').join(' | ') || String(error),
    httpStatus: typeof status === 'number' ? status : undefined,
    retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
    isAbort: e.name === 'AbortError' || e.name === 'TimeoutError' || (e as { code?: string }).code === 'ABORT_ERR',
  }
}

/**
 * Shared classifier. Adapters call this and may override for provider-native
 * signals they alone can see; everything generic lives here so the three
 * providers cannot drift into three different failover policies.
 */
export function classifyAIError(error: unknown, provider?: AIProviderId, model?: string): AIProviderError {
  if (error instanceof AIProviderError) return error

  const facts = extract(error)
  const opts = { provider, model, httpStatus: facts.httpStatus, retryAfterMs: facts.retryAfterMs, cause: error }
  const as = (category: AIErrorCategory) => new AIProviderError(category, facts.message, opts)

  if (facts.isAbort || TIMEOUT_PATTERN.test(facts.message)) return as('timeout')
  // Billing first — see the doc comment above. A 400 can be an outage.
  if (BILLING_PATTERN.test(facts.message)) return as('billing_exhausted')
  if (CONTEXT_PATTERN.test(facts.message)) return as('context_length_exceeded')

  if (facts.httpStatus === 401 || facts.httpStatus === 403) return as('authentication')
  if (facts.httpStatus === 429) {
    return QUOTA_PATTERN.test(facts.message) && !/rate/i.test(facts.message) ? as('quota') : as('rate_limit')
  }
  if (facts.httpStatus === 402) return as('billing_exhausted')
  if (facts.httpStatus === 408 || facts.httpStatus === 504) return as('timeout')
  if (facts.httpStatus && facts.httpStatus >= 500) return as('upstream_5xx')
  if (facts.httpStatus && facts.httpStatus >= 400) {
    // Before the tool-schema branch: an over-cap tools array mentions "tools"
    // but is a capacity limit, not a schema defect, and must fail over.
    if (PROVIDER_LIMIT_PATTERN.test(facts.message)) return as('unsupported_capability')
    if (TOOL_SCHEMA_PATTERN.test(facts.message)) return as('invalid_tool_or_schema')
    if (CONTENT_POLICY_PATTERN.test(facts.message)) return as('content_policy')
    return as('malformed_request')
  }

  if (NETWORK_PATTERN.test(facts.message)) return as('network')
  if (QUOTA_PATTERN.test(facts.message)) return as('quota')
  return as('unknown')
}
