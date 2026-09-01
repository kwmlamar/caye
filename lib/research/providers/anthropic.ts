import 'server-only'

import Anthropic from '@anthropic-ai/sdk'
import {
  createAnthropicResearchCompletion,
  createAnthropicResearchProvider,
} from '../anthropic'
import type {
  ResearchCapability,
  ResearchCompletionRequest,
  ResearchCompletionResult,
  ResearchProviderAdapter,
  ResearchProviderHealth,
} from './types'

const DEFAULT_RESEARCH_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-sonnet-5'

export interface AnthropicResearchProviderOptions {
  client?: Anthropic
  apiKey?: string
  model?: string
  onUsage?: (usage: { model: string; inputTokens?: number; outputTokens?: number }) => void
}

/**
 * Anthropic research provider, wrapped in the capability contract.
 *
 * The underlying search/fetch implementation in ../anthropic.ts is unchanged —
 * it uses Anthropic's server-side web_search and web_fetch tools, which return
 * durable document text directly. This adapter only adds capability declaration,
 * health, provenance identity, and the shared completion entry point.
 */
export function createAnthropicResearchAdapter(
  options: AnthropicResearchProviderOptions = {},
): ResearchProviderAdapter {
  const model = options.model ?? DEFAULT_RESEARCH_MODEL
  // Constructing Anthropic() throws when no key is present, so defer it.
  let cached: Anthropic | undefined = options.client
  const client = () => {
    if (!cached) cached = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : undefined)
    return cached
  }

  const capabilities: readonly ResearchCapability[] = [
    'web_search',
    'source_citations',
    'durable_source_fetch',
    'structured_output',
    'long_context',
  ]

  let sensor: ReturnType<typeof createAnthropicResearchProvider> | undefined
  const delegate = () => {
    if (!sensor) sensor = createAnthropicResearchProvider({ client: client(), model })
    return sensor
  }

  return {
    id: 'anthropic',
    model,
    name: `anthropic:${model}`,
    capabilities,

    async checkHealth(): Promise<ResearchProviderHealth> {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
      if (!options.client && !apiKey) return { usable: false, detail: 'ANTHROPIC_API_KEY is not set.' }
      return { usable: true }
    },

    search(query, searchOptions) {
      return delegate().search(query, searchOptions)
    },

    fetch(result) {
      return delegate().fetch(result)
    },

    complete(request: ResearchCompletionRequest): Promise<ResearchCompletionResult> {
      // No client injected: synthesis routes through the Caye AI Gateway
      // (pinned to Anthropic, since this adapter *is* the Anthropic entry in
      // the research router). That buys shared circuit-breaking, so an
      // exhausted balance stops costing a failed round trip per research
      // cycle before the router falls through to OpenAI. `search`/`fetch`
      // above still use the SDK directly — they need Anthropic's
      // server-side web tools, which the gateway does not model.
      return createAnthropicResearchCompletion({
        client: options.client,
        model,
        onUsage: options.onUsage,
      })(request)
    },
  }
}
