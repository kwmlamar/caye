import 'server-only'

import type { ResearchFetchedSource, ResearchSearchResult } from '../../research/runtime'
import { fetchResearchDocument } from '../../research/providers/source-fetch'
import type {
  ResearchCapability,
  ResearchCompletionRequest,
  ResearchCompletionResult,
  ResearchProviderAdapter,
  ResearchProviderHealth,
} from '../../research/providers/types'

/**
 * OpenRouter research provider — registered, configurable, and deliberately not
 * yet eligible for continuous research.
 *
 * OpenRouter can complete and can read a document Caye fetched, but this adapter
 * does NOT claim `web_search`, because OpenRouter's web plugin has not been
 * validated against Caye's citation requirements. Claiming a capability we have
 * not verified would let unattributed model prose enter the evidence substrate.
 *
 * The capability contract therefore filters OpenRouter out with reason
 * `capability_unsupported` until source discovery is implemented and tested.
 * Naming it in CAYE_RESEARCH_FALLBACKS is valid config, not an error.
 */

const DEFAULT_MODEL = process.env.OPENROUTER_RESEARCH_MODEL || 'openai/gpt-5'
const BASE_URL = 'https://openrouter.ai/api/v1'

type UnknownRecord = Record<string, unknown>

export function createOpenRouterResearchAdapter(options: {
  apiKey?: string
  model?: string
  fetch?: typeof globalThis.fetch
} = {}): ResearchProviderAdapter {
  const model = options.model ?? DEFAULT_MODEL
  const doFetch = options.fetch ?? globalThis.fetch

  // No 'web_search' and no 'source_citations' — see the file comment.
  const capabilities: readonly ResearchCapability[] = [
    'durable_source_fetch',
    'structured_output',
    'long_context',
  ]

  return {
    id: 'openrouter',
    model,
    name: `openrouter:${model}`,
    capabilities,

    async checkHealth(): Promise<ResearchProviderHealth> {
      const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
      return apiKey ? { usable: true } : { usable: false, detail: 'OPENROUTER_API_KEY is not set.' }
    },

    async search(): Promise<ResearchSearchResult[]> {
      throw new Error('OpenRouter research provider does not implement verified web search')
    },

    async fetch(result): Promise<ResearchFetchedSource> {
      const document = await fetchResearchDocument(result.url)
      return { ...result, title: result.title ?? document.title, content: document.content, fetchedAt: document.fetchedAt }
    },

    async complete(request: ResearchCompletionRequest): Promise<ResearchCompletionResult> {
      const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY
      if (!apiKey) {
        const error = new Error('OPENROUTER_API_KEY is not set')
        Object.assign(error, { authExpired: true })
        throw error
      }

      const response = await doFetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          max_tokens: request.maxOutputTokens,
        }),
      })

      const raw = await response.text()
      if (!response.ok) {
        const error = new Error(`${response.status} ${raw}`)
        Object.assign(error, { httpStatus: response.status })
        throw error
      }

      const json = JSON.parse(raw) as UnknownRecord
      const choice = (json.choices as UnknownRecord[] | undefined)?.[0]
      const message = choice?.message as UnknownRecord | undefined
      const usage = json.usage as UnknownRecord | undefined

      return {
        text: typeof message?.content === 'string' ? message.content : '',
        usage: usage ? {
          model: typeof json.model === 'string' ? json.model : model,
          inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
          outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
        } : undefined,
        truncated: choice?.finish_reason === 'length',
      }
    },
  }
}
