import 'server-only'

import type { ResearchFetchedSource, ResearchSearchResult } from '../runtime'
import { fetchResearchDocument } from './source-fetch'
import type {
  ResearchCapability,
  ResearchCompletionRequest,
  ResearchCompletionResult,
  ResearchProviderAdapter,
  ResearchProviderHealth,
} from './types'

/**
 * OpenAI research provider.
 *
 * Uses the Responses API web_search tool for discovery. The repository has no
 * `openai` SDK dependency — lib/model-router/backends/openai-compatible.ts calls
 * the HTTP API with plain fetch — so this adapter follows the same convention
 * rather than adding a package for one call site.
 *
 * Discovery and evidence are deliberately separate steps. web_search returns
 * url_citation annotations (real URLs the model consulted), never document
 * bodies; the durable snapshot is retrieved by Caye in ./source-fetch. The model
 * is a sensor pointing at sources, not the record of what those sources said.
 */

const DEFAULT_RESEARCH_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'gpt-5'
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const SEARCH_MAX_TOKENS = 2_048

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Parse url_citation annotations out of a Responses API payload.
 *
 * Shape (POST /v1/responses): output[] contains `web_search_call` items and a
 * `message` item whose content[] holds `output_text` parts carrying
 * `annotations[] = { type: 'url_citation', url, title, start_index, end_index }`.
 *
 * Exported for tests.
 */
export function extractOpenAiSearchResults(payload: unknown): ResearchSearchResult[] {
  const output = record(payload)?.output
  if (!Array.isArray(output)) return []

  const results: ResearchSearchResult[] = []
  const seen = new Set<string>()

  for (const itemValue of output) {
    const item = record(itemValue)
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue

    for (const partValue of item.content) {
      const part = record(partValue)
      if (part?.type !== 'output_text' || !Array.isArray(part.annotations)) continue

      for (const annotationValue of part.annotations) {
        const annotation = record(annotationValue)
        if (annotation?.type !== 'url_citation') continue
        const url = text(annotation.url)
        if (!url || seen.has(url)) continue
        seen.add(url)
        results.push({ url, title: text(annotation.title) ?? undefined })
      }
    }
  }

  return results
}

/** Concatenate assistant output_text. Exported for tests. */
export function extractOpenAiOutputText(payload: unknown): string {
  const root = record(payload)
  const direct = text(root?.output_text)
  if (direct) return direct

  const output = root?.output
  if (!Array.isArray(output)) return ''

  return output
    .map((itemValue) => record(itemValue))
    .filter((item): item is UnknownRecord => item?.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => (item.content as unknown[])
      .map((partValue) => record(partValue))
      .filter((part): part is UnknownRecord => part?.type === 'output_text')
      .map((part) => typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim()
}

function usageFrom(payload: unknown, model: string) {
  const usage = record(record(payload)?.usage)
  if (!usage) return undefined
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { model: text(record(payload)?.model) ?? model, inputTokens, outputTokens }
}

/**
 * Surface the provider's HTTP status on the thrown error so the shared
 * classifier (lib/model-router/error-classification) can tell a billing failure
 * from a transient one instead of guessing from prose.
 */
async function callOpenAi(body: UnknownRecord, apiKey: string, doFetch: typeof globalThis.fetch): Promise<UnknownRecord> {
  const response = await doFetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })

  const raw = await response.text()
  if (!response.ok) {
    const error = new Error(`${response.status} ${raw}`)
    Object.assign(error, { httpStatus: response.status })
    throw error
  }

  try {
    return JSON.parse(raw) as UnknownRecord
  } catch {
    throw new Error('OpenAI returned a non-JSON response body')
  }
}

export interface OpenAiResearchProviderOptions {
  apiKey?: string
  model?: string
  fetch?: typeof globalThis.fetch
  /** Injected in tests so document retrieval does not touch the network. */
  fetchDocument?: typeof fetchResearchDocument
  onUsage?: (usage: { model: string; inputTokens?: number; outputTokens?: number }) => void
}

export function createOpenAiResearchProvider(options: OpenAiResearchProviderOptions = {}): ResearchProviderAdapter {
  const model = options.model ?? DEFAULT_RESEARCH_MODEL
  const doFetch = options.fetch ?? globalThis.fetch
  const fetchDocument = options.fetchDocument ?? fetchResearchDocument

  const capabilities: readonly ResearchCapability[] = [
    'web_search',
    'source_citations',
    'durable_source_fetch',
    'structured_output',
    'long_context',
  ]

  function requireKey(): string {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      const error = new Error('OPENAI_API_KEY is not set')
      Object.assign(error, { authExpired: true })
      throw error
    }
    return apiKey
  }

  function reportUsage(payload: unknown) {
    const usage = usageFrom(payload, model)
    if (usage && options.onUsage) options.onUsage(usage)
    return usage
  }

  return {
    id: 'openai',
    model,
    name: `openai:${model}`,
    capabilities,

    async checkHealth(): Promise<ResearchProviderHealth> {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY
      return apiKey ? { usable: true } : { usable: false, detail: 'OPENAI_API_KEY is not set.' }
    },

    async search(query, searchOptions): Promise<ResearchSearchResult[]> {
      const payload = await callOpenAi({
        model,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        max_output_tokens: SEARCH_MAX_TOKENS,
        input: `Search the web for authoritative, diverse sources that directly help answer this research question. Prefer primary sources, official documentation, peer-reviewed work, and high-quality reporting. Cite every source you consult. Do not answer the question yet. Research question: ${query}`,
      }, requireKey(), doFetch)

      reportUsage(payload)
      return extractOpenAiSearchResults(payload).slice(0, searchOptions?.limit ?? 8)
    },

    async fetch(result): Promise<ResearchFetchedSource> {
      const document = await fetchDocument(result.url)
      return {
        ...result,
        // Keep the citation URL as canonical identity so the same source dedupes
        // across providers even when a redirect resolves differently.
        title: result.title ?? document.title,
        content: document.content,
        fetchedAt: document.fetchedAt,
      }
    },

    async complete(request: ResearchCompletionRequest): Promise<ResearchCompletionResult> {
      const payload = await callOpenAi({
        model,
        instructions: request.system,
        input: request.user,
        max_output_tokens: request.maxOutputTokens,
      }, requireKey(), doFetch)

      const usage = reportUsage(payload)
      return {
        text: extractOpenAiOutputText(payload),
        usage,
        truncated: record(payload)?.status === 'incomplete'
          && text(record(record(payload)?.incomplete_details)?.reason) === 'max_output_tokens',
      }
    },
  }
}
