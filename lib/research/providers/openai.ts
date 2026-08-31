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

// gpt-5-mini, not gpt-5: this account has 148 successful gpt-5-mini calls in
// production over the last 30 days and no recorded gpt-5 usage, so mini is the
// model whose access is actually evidenced here. It is also the cheaper option,
// which is the operating reason for this migration. Override with
// OPENAI_RESEARCH_MODEL once stronger reasoning is wanted and access is confirmed.
const DEFAULT_RESEARCH_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'gpt-5-mini'
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const SEARCH_MAX_TOKENS = 4_096

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Parse consulted sources out of a Responses API payload.
 *
 * Two channels, both required:
 *
 * 1. `message.content[].output_text.annotations[]` of type `url_citation`
 *    ({ url, title, start_index, end_index }) — the references the model
 *    actually cited in prose. Richest, but only present if it wrote prose.
 * 2. `web_search_call.action.sources[]`, returned when the request asks for
 *    `include: ["web_search_call.action.sources"]` — the complete list of URLs
 *    the model consulted.
 *
 * Channel 2 exists because channel 1 alone is not reliable on reasoning models:
 * the first production cycle after the provider migration returned zero
 * citations because hidden reasoning consumed the output budget before any
 * annotated text was emitted, so the run found no sources at all. Discovery
 * must not depend on the model choosing to narrate.
 *
 * Exported for tests.
 */
export function extractOpenAiSearchResults(payload: unknown): ResearchSearchResult[] {
  const output = record(payload)?.output
  if (!Array.isArray(output)) return []

  const results: ResearchSearchResult[] = []
  const seen = new Set<string>()

  const add = (rawUrl: unknown, rawTitle: unknown) => {
    const url = text(rawUrl)
    if (!url || seen.has(url)) return
    seen.add(url)
    results.push({ url, title: text(rawTitle) ?? undefined })
  }

  // Cited references first — they carry titles and reflect what the model used.
  for (const itemValue of output) {
    const item = record(itemValue)
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue

    for (const partValue of item.content) {
      const part = record(partValue)
      if (part?.type !== 'output_text' || !Array.isArray(part.annotations)) continue

      for (const annotationValue of part.annotations) {
        const annotation = record(annotationValue)
        if (annotation?.type !== 'url_citation') continue
        add(annotation.url, annotation.title)
      }
    }
  }

  // Then everything the search tool reports having consulted.
  for (const itemValue of output) {
    const item = record(itemValue)
    if (item?.type !== 'web_search_call') continue
    const sources = record(item.action)?.sources
    if (!Array.isArray(sources)) continue

    for (const sourceValue of sources) {
      const source = record(sourceValue)
      if (source) add(source.url, source.title)
      else add(sourceValue, undefined)
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
        // Return the full consulted list, not only what the model cites in prose.
        include: ['web_search_call.action.sources'],
        // Hidden reasoning is billed against max_output_tokens on GPT-5-class
        // models and will happily spend the entire budget before emitting any
        // text — the same trap documented in
        // lib/model-router/backends/openai-compatible.ts. Discovery does not
        // need deep reasoning; it needs sources.
        reasoning: { effort: 'low' },
        max_output_tokens: SEARCH_MAX_TOKENS,
        input: `Search the web for authoritative, diverse sources that directly help answer this research question. Prefer primary sources, official documentation, peer-reviewed work, and high-quality reporting. Then list the sources you consulted as a short bulleted list, citing each one. Do not answer the research question itself. Research question: ${query}`,
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
        // Same budget trap as search: the synthesis contract needs its tokens
        // spent on the JSON object, not on hidden reasoning that truncates it.
        reasoning: { effort: 'low' },
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
