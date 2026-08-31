import 'server-only'

import type { FallbackReasonCode } from '@/lib/model-router/types'
import type { ResearchFetchedSource, ResearchProvider, ResearchSearchResult } from '../runtime'

/**
 * Caye Intelligence owns research. A provider is an interchangeable cognition
 * supplier that satisfies a capability contract — nothing more.
 *
 * The desk runtime asks for "web research + citations + durable evidence +
 * structured extraction". It never asks for Claude, GPT, or any brand. Provider
 * -native request/response syntax stays behind the adapter; only the normalized
 * shapes in ./runtime cross the boundary into the Intelligence substrate.
 */
export type ResearchCapability =
  /** Can discover external sources on the live web. */
  | 'web_search'
  /** Returns source URLs/titles rather than unattributed prose. */
  | 'source_citations'
  /** Can produce the actual document text for a URL, so evidence is a real snapshot. */
  | 'durable_source_fetch'
  /** Can be held to a strict JSON output contract for evidence extraction. */
  | 'structured_output'
  /** Tolerates the multi-source synthesis payload without truncation. */
  | 'long_context'

/** Every research provider must satisfy all of these to be eligible. */
export const REQUIRED_RESEARCH_CAPABILITIES: readonly ResearchCapability[] = [
  'web_search',
  'source_citations',
  'durable_source_fetch',
  'structured_output',
] as const

export type ResearchProviderId = 'openai' | 'anthropic' | 'openrouter'

export interface ResearchProviderHealth {
  /** False means "do not spend a call on this provider right now". */
  usable: boolean
  /** Safe to persist in provenance. Never a raw key or stack. */
  detail?: string
}

/**
 * Raw completion usage a provider reports, normalized. Cost is computed by the
 * caller against lib/llm-pricing so pricing stays in one table.
 */
export interface ResearchUsage {
  model: string
  inputTokens?: number
  outputTokens?: number
}

/**
 * A research provider adapter.
 *
 * `search` + `fetch` satisfy the existing ResearchProvider sensor contract.
 * `complete` is the raw text-in/text-out call the shared, provider-independent
 * synthesis contract (./synthesis) drives — so epistemic rules, the JSON shape,
 * and evidence validation are identical no matter who serves the request.
 */
export interface ResearchProviderAdapter extends ResearchProvider {
  readonly id: ResearchProviderId
  /** Concrete model actually used, e.g. 'gpt-5'. Combined into `name` for provenance. */
  readonly model: string
  /** `${id}:${model}` — exactly what lands in research_runs.provider. */
  readonly name: string
  readonly capabilities: readonly ResearchCapability[]
  /** Must be cheap. Never spends a model prompt. */
  checkHealth(): Promise<ResearchProviderHealth>
  complete(input: ResearchCompletionRequest): Promise<ResearchCompletionResult>
}

export interface ResearchCompletionRequest {
  system: string
  user: string
  maxOutputTokens: number
}

export interface ResearchCompletionResult {
  text: string
  /** Undefined when the provider does not report usage. Never invented. */
  usage?: ResearchUsage
  /** True when the provider stopped because it hit the output token ceiling. */
  truncated?: boolean
}

/** One rejected provider in a routing decision, preserved for provenance. */
export interface ResearchFallbackStep {
  provider: ResearchProviderId
  reason: FallbackReasonCode | 'capability_unsupported' | 'not_configured'
  detail?: string
  /** Which operation was being attempted when this provider was dropped. */
  operation?: ResearchOperation
}

export type ResearchOperation = 'search' | 'fetch' | 'synthesize'

/**
 * The routing trail for a run. Caye's *belief* is provider-independent; the
 * evidence trail is deliberately not. This is what makes a fallback visible
 * instead of laundering it into "some model said so".
 */
export interface ResearchRoutingProvenance {
  preferred: ResearchProviderId
  configuredChain: ResearchProviderId[]
  /** Providers that actually served at least one operation, in first-use order. */
  served: string[]
  fallbacks: ResearchFallbackStep[]
  usage: {
    calls: number
    inputTokens: number
    outputTokens: number
    costUsd: number
  }
}

export type { ResearchFetchedSource, ResearchSearchResult }
