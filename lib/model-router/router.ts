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
  /** Founder setting: prefer subscription backends over API when both fit. Default true. */
  preferSubscriptionOverApi: boolean
}

export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  allowApiFallback: true,
  preferSubscriptionOverApi: true,
}

/**
 * Deterministic candidate ordering. No LLM call is spent choosing an LLM.
 *
 * Cost policy:
 *   - subscription backends still lead when available because they do not
 *     add per-token API spend to Caye.
 *   - ordinary metered fallback prefers OpenAI before Anthropic. Caye's
 *     OpenAI API backend defaults to the cost-efficient mini tier.
 *   - tasks explicitly asking for strongest reasoning, long context, or
 *     vision keep Anthropic first in the metered tail.
 *   - manual claude/openai modes continue to honor the founder's choice.
 */
export function planChain(
  requestedMode: RequestedMode,
  hints: RouterTaskHints | undefined,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY
): BackendId[] {
  const strongestShape = Boolean(hints?.preferStrongest || hints?.needsLongContext || hints?.needsVision)
  const apiTail: BackendId[] = !policy.allowApiFallback
    ? []
    : strongestShape
      ? ['anthropic_api', 'openai_api', 'openrouter']
      : ['openai_api', 'anthropic_api', 'openrouter']

  if (requestedMode === 'claude') {
    return dedupe(['claude_subscription', 'anthropic_api', ...apiTail])
  }
  if (requestedMode === 'openai') {
    return dedupe(['openai_codex_subscription', 'openai_api', ...apiTail])
  }
  if (requestedMode === 'api') {
    return apiTail
  }

  // auto
  if (!policy.preferSubscriptionOverApi) {
    return dedupe([...apiTail, 'claude_subscription', 'openai_codex_subscription'])
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

/** Shared chain-walk for plain reasoning and tool turns. */
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
    if (!backend) continue

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

/** Plain reasoning path. Side-effecting tool execution lives in the tool bridge. */
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
