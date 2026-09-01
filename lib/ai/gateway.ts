import 'server-only'
import { MODELS, type ModelKey } from './models'
import { applyProviderPriority, inferTask, providerPriorityOverride, routeForTask } from './routes'
import { policyFor } from './errors'
import { providerAdapter } from './providers'
import { isCircuitOpen, loadProviderHealth, recordProviderFailure, recordProviderSuccess } from './health'
import { loadProviderSettings, priorityOrder } from './provider-settings'
import { logAiCall, logRoutingDecision, usageFromResponse } from './telemetry'
import {
  AIProviderError,
  NoAIProviderAvailableError,
  type AICallContext,
  type AIErrorCategory,
  type AIMessageParams,
  type AIProviderId,
  type AIResult,
  type AIRouting,
  type AIRoutingAttempt,
} from './types'

/**
 * The Caye AI Gateway.
 *
 * Feature code asks for a capability; this decides who answers. Claude is one
 * replaceable supplier here, not infrastructure. Provider availability may
 * change latency/cost, but must never change Caye's authorization or business
 * policy.
 */

const RATE_LIMIT_RETRY_CAP_MS = 2_000

/** Provider/account-wide failures that make another model from the same vendor pointless in this request. */
const PROVIDER_WIDE_FAILURES = new Set<AIErrorCategory>([
  'billing_exhausted',
  'authentication',
  'quota',
  'rate_limit',
])

export interface GenerateArgs {
  params: AIMessageParams
  ctx: AICallContext
  signal?: AbortSignal
}

export async function generate({ params, ctx, signal }: GenerateArgs): Promise<AIResult> {
  const task = inferTask(ctx.source, ctx.task)
  const startedAt = Date.now()
  const attempts: AIRoutingAttempt[] = []
  const failedProviders = new Set<AIProviderId>()
  let failoverOccurred = false

  const [health, settings] = await Promise.all([loadProviderHealth(), loadProviderSettings()])
  const order = providerPriorityOverride() ?? priorityOrder(settings)
  const pinned = ctx.pinProvider
  const route = applyProviderPriority(routeForTask(task), order).filter(
    (key) => !pinned || MODELS[key as ModelKey].provider === pinned
  )

  let lastError: AIProviderError | undefined

  for (const key of route) {
    const spec = MODELS[key as ModelKey]
    const adapter = providerAdapter(spec.provider)
    const base = { provider: spec.provider, model: spec.id }

    if (failedProviders.has(spec.provider)) {
      attempts.push({ ...base, outcome: 'skipped_circuit_open', detail: 'Provider already failed this request with a provider-wide availability error.' })
      continue
    }
    if (settings.get(spec.provider)?.enabled === false) {
      attempts.push({ ...base, outcome: 'skipped_disabled' })
      continue
    }
    if (!adapter?.hasCredentials()) {
      attempts.push({ ...base, outcome: 'skipped_no_credentials', detail: `No API key configured for ${spec.provider}.` })
      continue
    }
    if (isCircuitOpen(health.get(spec.provider))) {
      const h = health.get(spec.provider)
      attempts.push({ ...base, outcome: 'skipped_circuit_open', detail: `${h?.reason ?? 'unavailable'} until ${h?.cooldownUntil}` })
      continue
    }
    const capability = adapter.supports(params, spec.id)
    if (!capability.ok) {
      attempts.push({ ...base, outcome: 'skipped_capability', detail: `Model cannot serve required capability: ${capability.missing}.` })
      continue
    }

    const outcome = await attemptProvider(adapter, params, spec.id, signal)

    if (outcome.ok) {
      attempts.push({ ...base, outcome: 'success', latencyMs: outcome.latencyMs })
      void recordProviderSuccess(spec.provider).catch(() => {})

      const routing: AIRouting = {
        task,
        provider: spec.provider,
        model: outcome.response.model || spec.id,
        attempts,
        // Skipping an unavailable/unconfigured route is routing, not failover.
        // This is true only after a real attempted model failed and a later
        // eligible route was attempted.
        fellBack: failoverOccurred,
        latencyMs: Date.now() - startedAt,
      }
      const usage = usageFromResponse(outcome.response)
      logAiCall({ ctx, routing, usage, outcome: 'success' })
      logRoutingDecision(ctx, routing, 'success')
      return { output: outcome.response, usage, routing }
    }

    const error = outcome.error
    lastError = error
    attempts.push({ ...base, outcome: error.category, detail: safeDetail(error.message), latencyMs: outcome.latencyMs })
    void recordProviderFailure(spec.provider, error.category, error.message).catch(() => {})

    if (PROVIDER_WIDE_FAILURES.has(error.category)) failedProviders.add(spec.provider)

    const policy = policyFor(error.category)
    if (!policy.failover) {
      const routing = failedRouting(task, spec.provider, spec.id, attempts, startedAt, failoverOccurred)
      logAiCall({ ctx, routing, outcome: 'failure', failureCategory: error.category })
      logRoutingDecision(ctx, routing, 'failure')
      throw error
    }
    failoverOccurred = true
  }

  const last = attempts[attempts.length - 1]
  const routing = failedRouting(task, last?.provider ?? 'anthropic', last?.model ?? 'none', attempts, startedAt, failoverOccurred)
  logAiCall({ ctx, routing, outcome: 'failure', failureCategory: lastError?.category ?? 'unknown' })
  logRoutingDecision(ctx, routing, 'failure')
  throw new NoAIProviderAvailableError(task, attempts, lastError)
}

type AttemptOutcome =
  | { ok: true; response: Awaited<ReturnType<ReturnType<typeof providerAdapter>['generate']>>; latencyMs: number }
  | { ok: false; error: AIProviderError; latencyMs: number }

/** One provider, with a single bounded same-provider retry for rate limits. */
async function attemptProvider(
  adapter: ReturnType<typeof providerAdapter>,
  params: AIMessageParams,
  model: string,
  signal?: AbortSignal
): Promise<AttemptOutcome> {
  const started = Date.now()
  try {
    const response = await adapter.generate(params, model, signal)
    return { ok: true, response, latencyMs: Date.now() - started }
  } catch (raw) {
    let error = adapter.classifyError(raw)

    if (policyFor(error.category).retrySameProvider && !signal?.aborted) {
      const wait = Math.min(error.opts.retryAfterMs ?? 500, RATE_LIMIT_RETRY_CAP_MS)
      await sleep(wait)
      try {
        const response = await adapter.generate(params, model, signal)
        return { ok: true, response, latencyMs: Date.now() - started }
      } catch (retryRaw) {
        error = adapter.classifyError(retryRaw)
      }
    }
    return { ok: false, error, latencyMs: Date.now() - started }
  }
}

function failedRouting(
  task: AIRouting['task'],
  provider: AIRouting['provider'],
  model: string,
  attempts: AIRoutingAttempt[],
  startedAt: number,
  fellBack: boolean
): AIRouting {
  return { task, provider, model, attempts, fellBack, latencyMs: Date.now() - startedAt }
}

/** Provider error text can echo request content; keep log lines bounded. */
function safeDetail(message: string): string {
  return message.slice(0, 300)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
