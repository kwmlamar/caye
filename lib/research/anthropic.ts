import 'server-only'

import Anthropic from '@anthropic-ai/sdk'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import type {
  ResearchFetchedSource,
  ResearchProvider,
  ResearchSearchResult,
} from './runtime'
import type { ResearchSynthesizer } from './worker'
import { createResearchSynthesizer, SYNTHESIS_MAX_TOKENS } from './providers/synthesis'
import type { ResearchCompletionRequest, ResearchCompletionResult } from './providers/types'

const DEFAULT_RESEARCH_MODEL = process.env.ANTHROPIC_RESEARCH_MODEL || 'claude-sonnet-5'
const MAX_SERVER_TOOL_CONTINUATIONS = 2

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Parse only source metadata returned by Anthropic's server-side web search. */
export function extractAnthropicSearchResults(content: unknown): ResearchSearchResult[] {
  if (!Array.isArray(content)) return []
  const results: ResearchSearchResult[] = []
  const seen = new Set<string>()

  for (const blockValue of content) {
    const block = record(blockValue)
    if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue

    for (const resultValue of block.content) {
      const result = record(resultValue)
      if (result?.type !== 'web_search_result') continue
      const url = text(result.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      results.push({
        url,
        title: text(result.title) ?? undefined,
      })
    }
  }

  return results
}

/**
 * Extract the actual fetched document text. We deliberately reject encrypted
 * search payloads and non-text fetches instead of pretending model prose is a
 * durable source snapshot.
 */
export function extractAnthropicFetchedDocument(content: unknown, expectedUrl: string): { content: string; fetchedAt?: string } | null {
  if (!Array.isArray(content)) return null

  for (const blockValue of content) {
    const block = record(blockValue)
    if (block?.type !== 'web_fetch_tool_result') continue
    const result = record(block.content)
    if (result?.type !== 'web_fetch_result') continue

    const url = text(result.url)
    if (!url || url !== expectedUrl) continue
    const document = record(result.content)
    const source = record(document?.source)
    if (document?.type !== 'document' || source?.type !== 'text') continue
    const data = text(source.data)
    if (!data) continue

    return {
      content: data,
      fetchedAt: text(result.retrieved_at) ?? undefined,
    }
  }

  return null
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((value) => record(value))
    .filter((value): value is UnknownRecord => value?.type === 'text')
    .map((value) => typeof value.text === 'string' ? value.text : '')
    .join('\n')
    .trim()
}

export function createAnthropicResearchProvider(options: {
  client?: Anthropic
  model?: string
} = {}): ResearchProvider {
  const client = options.client ?? new Anthropic()
  const model = options.model ?? DEFAULT_RESEARCH_MODEL

  return {
    name: `anthropic:${model}`,

    async search(query, searchOptions) {
      const messages: Anthropic.MessageParam[] = [{
        role: 'user',
        content: `Search the web for authoritative, diverse sources that directly help answer this research question. Prefer primary sources, official documentation, peer-reviewed work, and high-quality reporting. Do not answer the question yet. Research question: ${query}`,
      }]
      const tools: Anthropic.WebSearchTool20250305[] = [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 1,
      }]

      let response = await client.messages.create({ model, max_tokens: 1_024, messages, tools })
      for (let attempt = 0; response.stop_reason === 'pause_turn' && attempt < MAX_SERVER_TOOL_CONTINUATIONS; attempt += 1) {
        messages.push({ role: 'assistant', content: response.content })
        response = await client.messages.create({ model, max_tokens: 1_024, messages, tools })
      }
      if (response.stop_reason === 'pause_turn') throw new Error('Anthropic web search remained paused after continuation limit')

      return extractAnthropicSearchResults(response.content).slice(0, searchOptions?.limit ?? 8)
    },

    async fetch(result) {
      const messages: Anthropic.MessageParam[] = [{
        role: 'user',
        content: `Fetch this exact source URL so its underlying document can be stored as research evidence. Do not summarize it: ${result.url}`,
      }]
      const tools: Anthropic.WebFetchTool20250910[] = [{
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: 1,
        max_content_tokens: 20_000,
      }]

      let response = await client.messages.create({ model, max_tokens: 512, messages, tools })
      for (let attempt = 0; response.stop_reason === 'pause_turn' && attempt < MAX_SERVER_TOOL_CONTINUATIONS; attempt += 1) {
        messages.push({ role: 'assistant', content: response.content })
        response = await client.messages.create({ model, max_tokens: 512, messages, tools })
      }
      if (response.stop_reason === 'pause_turn') throw new Error(`Anthropic web fetch remained paused for ${result.url}`)

      const fetched = extractAnthropicFetchedDocument(response.content, result.url)
      if (!fetched) throw new Error(`Anthropic web fetch returned no durable text for ${result.url}`)

      return {
        ...result,
        content: fetched.content,
        fetchedAt: fetched.fetchedAt ?? new Date().toISOString(),
      } satisfies ResearchFetchedSource
    },
  }
}

/**
 * The plain text-in/text-out completion the shared synthesis contract drives.
 *
 * Routed through the Caye AI Gateway pinned to Anthropic: research already
 * has its own provider router (./providers/router.ts) that owns the
 * cross-vendor fallback, so this must stay honest about which vendor it
 * represents. What the gateway adds here is the circuit breaker — when the
 * Anthropic balance is exhausted, this stops paying a failed round trip
 * before the research router falls through to OpenAI.
 *
 * The web search / fetch calls below still use the Anthropic SDK directly:
 * they depend on Anthropic's *server-side* tools, which have no equivalent in
 * the gateway's chat-completion contract. That is an adapter, not a coupling
 * — OpenAI and OpenRouter research adapters exist alongside it.
 */
export function createAnthropicResearchCompletion(options: {
  /**
   * Explicit provider override. Bypasses the gateway entirely — used by
   * tests to drive the synthesis-recovery logic against scripted responses.
   * Production callers leave this unset so the call is routed and
   * circuit-broken like every other AI call.
   */
  client?: Anthropic
  model?: string
  onUsage?: (usage: { model: string; inputTokens?: number; outputTokens?: number }) => void
} = {}) {
  const model = options.model ?? DEFAULT_RESEARCH_MODEL
  const injected = options.client

  return async (request: ResearchCompletionRequest): Promise<ResearchCompletionResult> => {
    const response = injected
      ? await injected.messages.create({
          model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
        })
      : await loggedMessagesCreate(
          null,
          {
            model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
          },
          {
            source: 'lib/research/anthropic.ts:createAnthropicResearchCompletion',
            task: 'research',
            pinProvider: 'anthropic',
            callerRole: 'founder',
          }
        )

    if (options.onUsage) {
      options.onUsage({
        model,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      })
    }

    return {
      text: extractAssistantText(response.content),
      truncated: response.stop_reason === 'max_tokens',
    }
  }
}

/**
 * Anthropic synthesizer. The epistemic contract — prompt, JSON shape, evidence
 * validation, alias mapping, retry-on-violation — lives in
 * ./providers/synthesis.ts and is shared with every other provider, so swapping
 * providers cannot change how evidence becomes a claim.
 */
export function createAnthropicResearchSynthesizer(options: {
  client?: Anthropic
  model?: string
  onUsage?: (usage: { model: string; inputTokens?: number; outputTokens?: number }) => void
} = {}): ResearchSynthesizer {
  return createResearchSynthesizer(createAnthropicResearchCompletion(options))
}

export { SYNTHESIS_MAX_TOKENS }
