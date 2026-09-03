import 'server-only'
import { MODELS, type ModelKey } from './models'
import { applyProviderPriority, inferTask, providerPriorityOverride, routeForTask } from './routes'
import { policyFor } from './errors'
import { providerAdapter } from './providers'
import { isCircuitOpen, loadProviderHealth, recordProviderFailure, recordProviderSuccess } from './health'
import { loadProviderSettings, priorityOrder } from './provider-settings'
import { normalizeRequestForModel } from './request-normalization'
import { logAiCall, logRoutingDecision, usageFromResponse } from './telemetry'
import { accountFatalFallbackCause, alertProviderDegradation, isAccountFatal } from './degradation-alert'
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
  const configuredRoute = applyProviderPriority(routeForTask(task), order).filter(
    (key) => !pinned || MODELS[key as ModelKey].provider === pinned
  )
  // A provider-pinned surface is an explicit operator choice (for example,
  // Caye Direct's provider picker). Keep its configured gateway-catalogue
  // model first; ordinary callers remain route-controlled and cannot pin a
  // provider or model through params.model.
  const requestedPinnedModel = pinned
    ? (Object.keys(MODELS) as ModelKey[]).find(
        (key) => MODELS[key].provider === pinned && MODELS[key].id === params.model
      )
    : undefined
  const route = requestedPinnedModel
    ? [requestedPinnedModel, ...configuredRoute.filter((key) => key !== requestedPinnedModel)]
    : configuredRoute

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

    // Application code supplies one provider-neutral request. Normalize that
    // request to this model's declared transport limits before capability
    // checking or dispatch. This keeps provider limits at the AI boundary
    // instead of leaking vendor-specific branches into agent/tool code.
    const normalized = normalizeRequestForModel(spec, params)
    if (!normalized.ok) {
      attempts.push({
        ...base,
        outcome: 'skipped_capability',
        detail: `${normalized.detail} Model cannot serve required capability: ${normalized.missing}.`,
      })
      continue
    }
    const requestParams = normalized.value.params

    const capability = adapter.supports(requestParams, spec.id)
    if (!capability.ok) {
      attempts.push({ ...base, outcome: 'skipped_capability', detail: `Model cannot serve required capability: ${capability.missing}.` })
      continue
    }

    // Captured before the attempt so a success can be recognised as a
    // recovery transition rather than just another healthy call. Read from
    // the health map already loaded above — no extra query, no new state.
    const priorHealth = health.get(spec.provider)
    const wasInCooldown = priorHealth?.state === 'cooldown'

    const outcome = await attemptProvider(adapter, requestParams, spec.id, signal)

    if (outcome.ok) {
      attempts.push({
        ...base,
        outcome: 'success',
        ...(normalized.value.detail ? { detail: normalized.value.detail } : {}),
        latencyMs: outcome.latencyMs,
      })
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

      // A served request can still carry news. Two kinds, both fire-and-forget:
      // a user-facing request that changed vendor because an account died, and
      // a provider that just came back from cooldown.
      const fallbackCause = accountFatalFallbackCause(routing)
      if (fallbackCause) {
        alertProviderDegradation({ kind: 'user_facing_fallback', ctx, routing, ...fallbackCause })
      }
      if (wasInCooldown) {
        alertProviderDegradation({
          kind: 'provider_recovered',
          ctx,
          routing,
          provider: spec.provider,
          previousReason: priorHealth?.reason ?? null,
        })
      }
      return { output: outcome.response, usage, routing }
    }

    const error = outcome.error
    lastError = error
    attempts.push({ ...base, outcome: error.category, detail: safeDetail(error.message), latencyMs: outcome.latencyMs })
    void recordProviderFailure(spec.provider, error.category, error.message).catch(() => {})

    // An account-level failure is news the moment it happens, whether or not
    // a later provider rescues the request. Raised here rather than at an
    // exit because billing_exhausted fails over (policy.failover === true),
    // so a successful failover would otherwise hide the dead account.
    if (isAccountFatal(error.category)) {
      alertProviderDegradation({
        kind: 'account_fatal',
        ctx,
        provider: spec.provider,
        category: error.category,
        task,
        detail: error.message,
      })
    }

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
  // Nothing served this request. Highest severity in the module, and the one
  // case that is not a failover story at all.
  alertProviderDegradation({ kind: 'chain_exhausted', ctx, routing, detail: lastError?.message ?? null })
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
