import 'server-only'
import { classifyBackendError, type RawBackendError } from './error-classification'
import { requiredCapabilitiesFor, backendSupports } from './capabilities'
import type {
  BackendId,
  FallbackReasonCode,
  ModelBackend,
  ModelInvokeRequest,
  ModelInvokeResult,
  RequestedMode,
  RouterDecision,
  RouterTaskHints,
} from './types'

export interface RouterPolicy {
  /** Founder setting: allow falling back to metered API backends. Default true. */
  allowApiFallback: boolean
  /** Founder setting: prefer subscription backends over API when both fit. Default true — that's the whole point. */
  preferSubscriptionOverApi: boolean
}

export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  allowApiFallback: true,
  preferSubscriptionOverApi: true,
}

/**
 * Deterministic candidate ordering. No LLM call — see brief section 6:
 * "Do NOT use another expensive LLM just to choose an LLM unless there is
 * strong evidence it is necessary."
 *
 * Policy (subject to revision once real usage data exists — section 16
 * explicitly defers learning this from outcomes):
 *   - manual claude/openai/api: that backend first, no cross-provider
 *     fallback baked in (api fallback still applies per policy.allowApiFallback
 *     for claude/openai if the founder allows it).
 *   - auto + coding/repo-heavy: openai_codex_subscription first (Codex is
 *     the coding-specialized subscription surface), then claude_subscription.
 *   - auto + everything else: claude_subscription first (long-context /
 *     conversational business reasoning is Caye Direct's default shape),
 *     then openai_codex_subscription.
 *   - api backends are always last in an auto chain, gated by allowApiFallback.
 */
export function planChain(
  requestedMode: RequestedMode,
  hints: RouterTaskHints | undefined,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY
): BackendId[] {
  const apiTail: BackendId[] = policy.allowApiFallback ? ['anthropic_api', 'openai_api'] : []

  if (requestedMode === 'claude') {
    return dedupe(['claude_subscription', ...apiTail.filter((b) => b === 'anthropic_api'), ...apiTail])
  }
  if (requestedMode === 'openai') {
    return dedupe(['openai_codex_subscription', ...apiTail.filter((b) => b === 'openai_api'), ...apiTail])
  }
  if (requestedMode === 'api') {
    return policy.allowApiFallback ? ['anthropic_api', 'openai_api'] : []
  }

  // auto
  if (!policy.preferSubscriptionOverApi) {
    return dedupe(['anthropic_api', 'openai_api', 'claude_subscription', 'openai_codex_subscription'])
  }
  const codingLed = hints?.isCodingOrRepoTask
  const subscriptionOrder: BackendId[] = codingLed
    ? ['openai_codex_subscription', 'claude_subscription']
    : ['claude_subscription', 'openai_codex_subscription']
  return dedupe([...subscriptionOrder, ...apiTail])
}

function dedupe(chain: BackendId[]): BackendId[] {
  return [...new Set(chain)]
}

/** Drops candidates that structurally cannot satisfy the task's required capabilities. */
export function filterByCapability(chain: BackendId[], hints: RouterTaskHints | undefined): BackendId[] {
  const required = requiredCapabilitiesFor(hints)
  return chain.filter((backend) => required.every((cap) => backendSupports(backend, cap)))
}

export class NoBackendAvailableError extends Error {
  constructor(public readonly decision: RouterDecision, public readonly lastReason?: FallbackReasonCode) {
    super(
      decision.chain.length === 0
        ? 'No reasoning backend is eligible for this request (capability/policy filtered the chain to empty).'
        : `No reasoning backend is currently available. Tried: ${decision.fallbacksTried
            .map((f) => `${f.backend} (${f.reason})`)
            .join(', ') || 'none'}.`
    )
    this.name = 'NoBackendAvailableError'
  }
}

/**
 * Shared chain-walk: health-check, invoke, classify-and-continue-or-throw.
 * Used by both the plain-reasoning router (runWithFallback) and the
 * tool-turn router (tool-bridge/founder-tool-loop.ts's
 * runToolTurnWithFallback) so there is exactly one implementation of
 * "how Auto tries backends in order and falls back" — not two drifting
 * copies with slightly different bugs.
 *
 * `restrictToChain`, when set, replaces the planned chain outright rather
 * than filtering it — this is how the tool loop pins to a single backend
 * once a write tool has been attempted this turn (see
 * founder-tool-loop.ts's `writeAttempted` guard): the point is that NO
 * other candidate is even considered, not that the normal chain is
 * filtered down to one entry by capability.
 */
export async function runChainWithFallback<R>(
  backends: readonly ModelBackend[],
  requestedMode: RequestedMode,
  hints: RouterTaskHints | undefined,
  invokeFn: (backend: ModelBackend, signal: AbortSignal) => Promise<R>,
  signal: AbortSignal,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY,
  restrictToChain?: BackendId[]
): Promise<{ result: R; decision: RouterDecision }> {
  const byId = new Map(backends.map((b) => [b.id, b] as const))
  const chain = restrictToChain ?? filterByCapability(planChain(requestedMode, hints, policy), hints)

  const decision: RouterDecision = { requestedMode, chain, fallbacksTried: [] }

  for (const backendId of chain) {
    const backend = byId.get(backendId)
    if (!backend) continue // not registered in this deployment (e.g. openai_api not built yet)

    const health = await backend.checkHealth()
    if (health.state !== 'available' && health.state !== 'healthy') {
      decision.fallbacksTried.push({
        backend: backendId,
        reason: mapHealthStateToFallbackReason(health.state),
      })
      continue
    }

    try {
      const result = await invokeFn(backend, signal)
      decision.selected = backendId
      return { result, decision }
    } catch (err) {
      const classified = classifyBackendError(toRawBackendError(err))
      if (!classified.fallback) throw err
      decision.fallbacksTried.push({ backend: backendId, reason: classified.reason })
      continue
    }
  }

  throw new NoBackendAvailableError(decision)
}

/**
 * Side effects (tool calls with external consequences) are not executed by
 * this plain-reasoning path at all — see capabilities.ts's doc comment.
 * The side-effect guard below is real and tested (a backend can already
 * throw an error tagged `sideEffectOccurred`, checked first in
 * classifyBackendError), it just has no caller that sets that flag on
 * THIS path. The tool-turn path (tool-bridge/founder-tool-loop.ts) is
 * where real tool execution happens and where this actually bites.
 */
export async function runWithFallback(
  backends: readonly ModelBackend[],
  requestedMode: RequestedMode,
  req: ModelInvokeRequest,
  signal: AbortSignal,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY
): Promise<{ result: ModelInvokeResult; decision: RouterDecision }> {
  return runChainWithFallback(
    backends,
    requestedMode,
    req.hints,
    (backend, s) => backend.invoke(req, s),
    signal,
    policy
  )
}

function mapHealthStateToFallbackReason(state: string): FallbackReasonCode {
  switch (state) {
    case 'rate_limited':
      return 'rate_limited'
    case 'quota_exhausted':
      return 'quota_exhausted'
    case 'auth_required':
      return 'auth_required'
    default:
      return 'client_unavailable'
  }
}

function toRawBackendError(err: unknown): RawBackendError {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as Record<string, unknown>
    // `.status` is how the Anthropic/OpenAI SDKs' own APIError classes
    // expose HTTP status; `.httpStatus` is what this module's own CLI
    // backends attach (see claude-subscription.ts). Accept either.
    const httpStatus = e.httpStatus ?? e.status
    return {
      message: String(e.message ?? 'unknown error'),
      httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
      exitCode: typeof e.exitCode === 'number' ? e.exitCode : undefined,
      clientMissing: e.code === 'ENOENT',
      authExpired: e.authExpired === true,
      sideEffectOccurred: e.sideEffectOccurred === true,
      quotaExhausted: e.quotaExhausted === true,
    }
  }
  return { message: String(err) }
}
