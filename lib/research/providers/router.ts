import 'server-only'

import { classifyBackendError, type RawBackendError } from '@/lib/model-router/error-classification'
import type { FallbackReasonCode } from '@/lib/model-router/types'
import { costForModel } from '@/lib/llm-pricing'
import type { ResearchFetchedSource, ResearchProvider, ResearchSearchResult } from '../runtime'
import type { ResearchSynthesizer } from '../worker'
import { createResearchSynthesizer } from './synthesis'
import { RESEARCH_SOURCE_FAILURE } from './source-fetch'
import {
  DEFAULT_PROVIDER_FACTORIES,
  resolveResearchProviderPreference,
  supportsResearch,
  type ResearchProviderFactories,
} from './config'
import type {
  ResearchFallbackStep,
  ResearchOperation,
  ResearchProviderAdapter,
  ResearchProviderId,
  ResearchRoutingProvenance,
} from './types'

/**
 * Deterministic research provider routing.
 *
 * Ordering is configuration, never chance: the preferred provider is tried
 * first, then configured fallbacks, in order, every single call. There is no
 * load balancing and no random selection — two identical desk cycles pick the
 * same provider.
 *
 * The session-scoped failure memo is the part that matters operationally. A
 * provider that fails *permanently* (billing exhausted, bad credentials) is
 * marked dead for the whole worker invocation, so a desk cycle that runs a
 * dozen questions makes exactly one doomed call to a zero-credit account
 * instead of one per question per source.
 */


const TRANSIENT_RETRY_LIMIT = 1
const TRANSIENT_RETRY_DELAY_MS = 750

/** Permanent for this session: retrying the same provider cannot help. */
const PERMANENT_REASONS: ReadonlySet<FallbackReasonCode> = new Set<FallbackReasonCode>([
  'quota_exhausted',
  'auth_required',
  'client_unavailable',
  'capability_unsupported',
])

export class NoResearchProviderError extends Error {
  constructor(readonly provenance: ResearchRoutingProvenance, eligible: readonly ResearchProviderId[] = []) {
    const tried = provenance.fallbacks.map((step) => `${step.provider} (${step.reason})`).join(', ')
    super(
      eligible.length === 0
        ? `No research provider is configured that satisfies the required research capabilities. Rejected: ${tried || 'none'}.`
        : `No research provider is currently available. Tried: ${tried || 'none'}.`,
    )
    this.name = 'NoResearchProviderError'
  }
}

function toRawBackendError(error: unknown): RawBackendError {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>
    const httpStatus = value.httpStatus ?? value.status
    return {
      message: String(value.message ?? 'unknown error'),
      httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
      clientMissing: value.code === 'ENOENT',
      authExpired: value.authExpired === true,
      quotaExhausted: value.quotaExhausted === true,
    }
  }
  return { message: String(error) }
}

function isSourceFailure(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<string, unknown>)[RESEARCH_SOURCE_FAILURE])
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface ResearchRouterOptions {
  env?: NodeJS.ProcessEnv
  factories?: ResearchProviderFactories
  /** Test seam: skip the real backoff. */
  sleep?: (ms: number) => Promise<void>
}

export interface ResearchRunBinding {
  /** Drop-in for executeResearchRun's `provider`. `name` reports who actually served. */
  provider: ResearchProvider
  synthesize: ResearchSynthesizer
  provenance(): ResearchRoutingProvenance
}

export interface ResearchProviderSession {
  /** Eligible chain after capability filtering, in try order. */
  readonly chain: ResearchProviderId[]
  readonly preferred: ResearchProviderId
  /** Fresh provenance scope for one research run. Failure memo is shared across runs. */
  beginRun(): ResearchRunBinding
}

/**
 * Create a routing session. One per worker invocation (one desk cycle, or one
 * queued-research job), so the dead-provider memo spans the whole cycle.
 */
export function createResearchProviderSession(options: ResearchRouterOptions = {}): ResearchProviderSession {
  const env = options.env ?? process.env
  const factories = options.factories ?? DEFAULT_PROVIDER_FACTORIES
  const pause = options.sleep ?? sleep
  const preference = resolveResearchProviderPreference(env)

  /** Providers ruled out for the remainder of this session. */
  const dead = new Map<ResearchProviderId, ResearchFallbackStep>()
  const adapters = new Map<ResearchProviderId, ResearchProviderAdapter>()
  const capabilityRejections: ResearchFallbackStep[] = []
  const chain: ResearchProviderId[] = []

  for (const id of preference.chain) {
    const factory = factories[id]
    if (!factory) {
      capabilityRejections.push({ provider: id, reason: 'not_configured', detail: `No adapter registered for ${id}.` })
      continue
    }

    let adapter: ResearchProviderAdapter
    try {
      adapter = factory()
    } catch (error) {
      capabilityRejections.push({
        provider: id,
        reason: 'client_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (!supportsResearch(adapter)) {
      capabilityRejections.push({
        provider: id,
        reason: 'capability_unsupported',
        detail: `${id} does not declare all required research capabilities.`,
      })
      continue
    }

    adapters.set(id, adapter)
    chain.push(id)
  }

  return {
    chain,
    preferred: preference.preferred,

    beginRun(): ResearchRunBinding {
      const fallbacks: ResearchFallbackStep[] = [...capabilityRejections]
      const served: string[] = []
      const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      let lastServed: string | null = null

      function noteFallback(step: ResearchFallbackStep) {
        // Record once per provider+operation so a 8-source run does not write
        // eight identical "anthropic quota_exhausted" entries.
        const duplicate = fallbacks.some((entry) =>
          entry.provider === step.provider && entry.reason === step.reason && entry.operation === step.operation)
        if (!duplicate) fallbacks.push(step)
      }

      function recordUsage(providerUsage: { model: string; inputTokens?: number; outputTokens?: number } | undefined) {
        if (!providerUsage) return
        usage.calls += 1
        usage.inputTokens += providerUsage.inputTokens ?? 0
        usage.outputTokens += providerUsage.outputTokens ?? 0
        // Unknown models price at 0 rather than an invented number; tokens are
        // still recorded so spend stays auditable.
        usage.costUsd += costForModel(
          providerUsage.model,
          providerUsage.inputTokens ?? 0,
          providerUsage.outputTokens ?? 0,
          0,
          0,
        )
      }

      /**
       * Run `operation` against the first eligible provider, falling back on
       * provider-availability failures only.
       */
      async function withFallback<T>(
        operation: ResearchOperation,
        run: (adapter: ResearchProviderAdapter) => Promise<T>,
      ): Promise<T> {
        for (const id of chain) {
          const alreadyDead = dead.get(id)
          if (alreadyDead) {
            noteFallback({ ...alreadyDead, operation })
            continue
          }

          const adapter = adapters.get(id)
          if (!adapter) continue

          const health = await adapter.checkHealth()
          if (!health.usable) {
            const step: ResearchFallbackStep = { provider: id, reason: 'auth_required', detail: health.detail }
            dead.set(id, step)
            noteFallback({ ...step, operation })
            continue
          }

          let attempt = 0
          for (;;) {
            try {
              const result = await run(adapter)
              if (!served.includes(adapter.name)) served.push(adapter.name)
              lastServed = adapter.name
              return result
            } catch (error) {
              // A dead link or a 404 on someone's website is not this
              // provider's fault. Surface it to the caller, which already
              // tolerates per-source fetch failures, and keep the provider.
              if (isSourceFailure(error)) throw error

              const classified = classifyBackendError(toRawBackendError(error))
              if (!classified.fallback) throw error

              const detail = error instanceof Error ? error.message : String(error)
              if (PERMANENT_REASONS.has(classified.reason)) {
                const step: ResearchFallbackStep = { provider: id, reason: classified.reason, detail }
                dead.set(id, step)
                noteFallback({ ...step, operation })
                break
              }

              if (attempt < TRANSIENT_RETRY_LIMIT) {
                attempt += 1
                await pause(classified.retryAfterMs ?? TRANSIENT_RETRY_DELAY_MS)
                continue
              }

              noteFallback({ provider: id, reason: classified.reason, detail, operation })
              break
            }
          }
        }

        throw new NoResearchProviderError(buildProvenance(), chain)
      }

      function buildProvenance(): ResearchRoutingProvenance {
        return {
          preferred: preference.preferred,
          configuredChain: preference.chain,
          served: [...served],
          fallbacks: [...fallbacks],
          usage: { ...usage, costUsd: Number(usage.costUsd.toFixed(6)) },
        }
      }

      const provider: ResearchProvider = {
        // Reports the provider that actually served most recently. At the point
        // executeResearchRun persists, that is the synthesis provider — the
        // epistemically decisive call — so research_runs.provider is never a
        // guess. Before any call it reports the preferred provider.
        get name() {
          return lastServed ?? `${preference.preferred}:unrouted`
        },
        search(query, searchOptions): Promise<ResearchSearchResult[]> {
          return withFallback('search', (adapter) => adapter.search(query, searchOptions))
        },
        fetch(result): Promise<ResearchFetchedSource> {
          return withFallback('fetch', (adapter) => adapter.fetch(result))
        },
      }

      const synthesize = createResearchSynthesizer((request) =>
        withFallback('synthesize', async (adapter) => {
          const result = await adapter.complete(request)
          recordUsage(result.usage)
          return result
        }))

      return { provider, synthesize, provenance: buildProvenance }
    },
  }
}
