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
  type AIMessageParams,
  type AIResult,
  type AIRouting,
  type AIRoutingAttempt,
} from './types'

/**
 * The Caye AI Gateway.
 *
 * Feature code asks for a capability; this decides who answers. Claude is one
 * replaceable supplier here, not infrastructure — if the Anthropic account is
 * out of credit, rate limited, or down, the same request is served by OpenAI
 * or OpenRouter and the caller cannot tell the difference from the response
 * shape alone (only from `result.routing`).
 *
 * What this layer explicitly does NOT do, and must never start doing:
 * workspace isolation, booking rules, approval gates, tool authorization,
 * operator precedence, learning eligibility, customer-communication policy.
 * Those are decided before a request reaches here and enforced after it
 * returns, by the same deterministic code regardless of who served the turn.
 * A provider swap changes latency and cost. It must never change what Caye
 * is allowed to do.
 */

const RATE_LIMIT_RETRY_CAP_MS = 2_000

export interface GenerateArgs {
  params: AIMessageParams
  ctx: AICallContext
  signal?: AbortSignal
}

export async function generate({ params, ctx, signal }: GenerateArgs): Promise<AIResult> {
  const task = inferTask(ctx.source, ctx.task)
  const startedAt = Date.now()
  const attempts: AIRoutingAttempt[] = []

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
        fellBack: attempts.length > 1,
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

    // Deterministic, request-shaped failure (or a possible side effect):
    // stop. Fanning the same broken request across three providers buys
    // three identical errors, three bills, and a slower failure.
    if (!policyFor(error.category).failover) {
      const routing = failedRouting(task, spec.provider, spec.id, attempts, startedAt)
      logAiCall({ ctx, routing, outcome: 'failure', failureCategory: error.category })
      logRoutingDecision(ctx, routing, 'failure')
      throw error
    }
  }

  const last = attempts[attempts.length - 1]
  const routing = failedRouting(task, last?.provider ?? 'anthropic', last?.model ?? 'none', attempts, startedAt)
  logAiCall({ ctx, routing, outcome: 'failure', failureCategory: lastError?.category ?? 'unknown' })
  logRoutingDecision(ctx, routing, 'failure')
  throw new NoAIProviderAvailableError(task, attempts, lastError)
}

type AttemptOutcome =
  | { ok: true; response: Awaited<ReturnType<ReturnType<typeof providerAdapter>['generate']>>; latencyMs: number }
  | { ok: false; error: AIProviderError; latencyMs: number }

/**
 * One provider, with a single bounded same-provider retry for rate limits.
 *
 * Rate limiting is the one failure where the same provider is likely to
 * succeed moments later, and where failing over immediately would push a
 * transient spike onto a provider that may be more expensive or less suited
 * to the task. Everything else fails over straight away — retrying a 500 or a
 * timeout in place just adds latency to an already-slow request.
 */
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
  startedAt: number
): AIRouting {
  return { task, provider, model, attempts, fellBack: attempts.length > 1, latencyMs: Date.now() - startedAt }
}

/** Provider error text can echo request content; keep log lines bounded. */
function safeDetail(message: string): string {
  return message.slice(0, 300)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
