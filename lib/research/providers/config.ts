import 'server-only'

import { REQUIRED_RESEARCH_CAPABILITIES, type ResearchProviderAdapter, type ResearchProviderId } from './types'
import { createOpenAiResearchProvider } from './openai'
import { createAnthropicResearchAdapter } from './anthropic'
import { createOpenRouterResearchAdapter } from './openrouter'
import { logGenericLlmUsage } from '@/lib/llm-telemetry'

/**
 * Deterministic research provider preference.
 *
 * Defaults are code, not deployment state, so Caye Intelligence keeps working
 * without an env change:
 *
 *   CAYE_RESEARCH_PROVIDER=openai
 *   CAYE_RESEARCH_FALLBACKS=anthropic,openrouter
 *
 * OpenAI leads because the production Anthropic account is out of credit and
 * OpenAI is materially cheaper per research cycle. Anthropic remains a
 * first-class fallback and becomes preferred again by setting one env var.
 */
export const DEFAULT_RESEARCH_PROVIDER: ResearchProviderId = 'openai'
export const DEFAULT_RESEARCH_FALLBACKS: ResearchProviderId[] = ['anthropic', 'openrouter']

const KNOWN_PROVIDERS: ResearchProviderId[] = ['openai', 'anthropic', 'openrouter']

function parseProviderId(value: string | undefined): ResearchProviderId | null {
  const candidate = value?.trim().toLowerCase()
  return candidate && (KNOWN_PROVIDERS as string[]).includes(candidate)
    ? candidate as ResearchProviderId
    : null
}

export function parseProviderList(value: string | undefined): ResearchProviderId[] {
  if (!value) return []
  return [...new Set(
    value.split(',')
      .map((entry) => parseProviderId(entry))
      .filter((entry): entry is ResearchProviderId => entry !== null),
  )]
}

export interface ResearchProviderPreference {
  preferred: ResearchProviderId
  /** Preferred first, then configured fallbacks, deduped. */
  chain: ResearchProviderId[]
  /** Config values that were present but not recognized. Surfaced, never silently dropped. */
  ignored: string[]
}

export function resolveResearchProviderPreference(env: NodeJS.ProcessEnv = process.env): ResearchProviderPreference {
  const ignored: string[] = []

  const rawPreferred = env.CAYE_RESEARCH_PROVIDER?.trim()
  const preferred = parseProviderId(rawPreferred) ?? DEFAULT_RESEARCH_PROVIDER
  if (rawPreferred && !parseProviderId(rawPreferred)) ignored.push(rawPreferred)

  const rawFallbacks = env.CAYE_RESEARCH_FALLBACKS
  const fallbacks = rawFallbacks === undefined
    ? DEFAULT_RESEARCH_FALLBACKS
    : parseProviderList(rawFallbacks)
  if (rawFallbacks) {
    for (const entry of rawFallbacks.split(',').map((value) => value.trim()).filter(Boolean)) {
      if (!parseProviderId(entry)) ignored.push(entry)
    }
  }

  return { preferred, chain: [...new Set([preferred, ...fallbacks])], ignored }
}

export type ResearchProviderFactories = Partial<Record<ResearchProviderId, () => ResearchProviderAdapter>>

/**
 * Research spend belongs in the same ledger as every other Caye LLM call, so
 * the admin spend surface does not quietly under-report continuous research.
 * Fire-and-forget: a telemetry write must never fail a research run.
 */
function researchUsageLogger(source: string) {
  return (usage: { model: string; inputTokens?: number; outputTokens?: number }) => {
    void logGenericLlmUsage(usage, { source, callerRole: 'founder' })
      .catch((error) => console.error('[research/providers] usage log failed:', error))
  }
}

export const DEFAULT_PROVIDER_FACTORIES: ResearchProviderFactories = {
  openai: () => createOpenAiResearchProvider({ onUsage: researchUsageLogger('lib/research/providers/openai.ts:research') }),
  anthropic: () => createAnthropicResearchAdapter({ onUsage: researchUsageLogger('lib/research/providers/anthropic.ts:research') }),
  openrouter: () => createOpenRouterResearchAdapter(),
}

/** A provider is eligible only if it declares every capability research requires. */
export function supportsResearch(adapter: ResearchProviderAdapter): boolean {
  return REQUIRED_RESEARCH_CAPABILITIES.every((capability) => adapter.capabilities.includes(capability))
}
