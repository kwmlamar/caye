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
  /** Allow subscription-backed requests to spill into metered API usage. Cloud Caye Direct needs this by default. */
  allowApiFallback: boolean
  /** Prefer subscription backends over API when both fit. Default true. */
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
 *   - subscription backends lead when available.
 *   - cloud deployments may not have subscription CLIs, so metered fallback
 *     remains enabled by default to keep Caye Direct functional.
 *   - ordinary metered use prefers the cheaper OpenAI API before Anthropic.
 *   - strongest, long-context, or vision shapes preserve Anthropic-first ordering.
 *   - explicit `api` mode always means intentional metered usage.
 *   - callers may still pass allowApiFallback:false where failing closed is preferred.
 */
export function planChain(
  requestedMode: RequestedMode,
  hints: RouterTaskHints | undefined,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY
): BackendId[] {
  const strongestShape = Boolean(hints?.preferStrongest || hints?.needsLongContext || hints?.needsVision)
  const meteredOrder: BackendId[] = strongestShape
    ? ['anthropic_api', 'openai_api', 'openrouter']
    : ['openai_api', 'anthropic_api', 'openrouter']
  const fallbackTail: BackendId[] = policy.allowApiFallback ? meteredOrder : []

  if (requestedMode === 'claude') {
    return dedupe(['claude_subscription', ...(policy.allowApiFallback ? ['anthropic_api' as const, ...meteredOrder] : [])])
  }
  if (requestedMode === 'openai') {
    return dedupe(['openai_codex_subscription', ...(policy.allowApiFallback ? ['openai_api' as const, ...meteredOrder] : [])])
  }
  if (requestedMode === 'api') {
    return meteredOrder
  }

  if (!policy.preferSubscriptionOverApi && policy.allowApiFallback) {
    return dedupe([...meteredOrder, 'claude_subscription', 'openai_codex_subscription'])
  }
  const codingLed = hints?.isCodingOrRepoTask
  const subscriptionOrder: BackendId[] = codingLed
    ? ['openai_codex_subscription', 'claude_subscription']
    : ['claude_subscription', 'openai_codex_subscription']
  return dedupe([...subscriptionOrder, ...fallbackTail])
}

function dedupe(chain: BackendId[]): BackendId[] {
  return [...new Set(chain)]
}

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
      decision.fallbacksTried.push({ backend: backendId, reason: mapHealthStateToFallbackReason(health.state) })
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
    }
  }

  throw new NoBackendAvailableError(decision)
}

export async function runWithFallback(
  backends: readonly ModelBackend[],
  requestedMode: RequestedMode,
  req: ModelInvokeRequest,
  signal: AbortSignal,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY
): Promise<{ result: ModelInvokeResult; decision: RouterDecision }> {
  return runChainWithFallback(backends, requestedMode, req.hints, (backend, s) => backend.invoke(req, s), signal, policy)
}

function mapHealthStateToFallbackReason(state: string): FallbackReasonCode {
  switch (state) {
    case 'rate_limited': return 'rate_limited'
    case 'quota_exhausted': return 'quota_exhausted'
    case 'auth_required': return 'auth_required'
    default: return 'client_unavailable'
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
