import 'server-only'
import type { AIMessageParams } from './types'
import type { ModelSpec } from './models'

type RequestTool = NonNullable<AIMessageParams['tools']>[number]

export interface RequestNormalization {
  params: AIMessageParams
  detail?: string
}

export type RequestNormalizationResult =
  | { ok: true; value: RequestNormalization }
  | { ok: false; missing: 'tool_capacity'; detail: string }

/**
 * Convert Caye's provider-neutral request into a request that fits one model's
 * hard transport limits without changing application authorization or tool
 * execution semantics.
 *
 * Today the only shape adaptation we need is tool-array capacity, but this is
 * deliberately model-driven rather than OpenAI-specific. A future provider
 * with a different cap gets the same behavior by declaring `maxTools` in the
 * catalogue instead of teaching feature code about that vendor.
 */
export function normalizeRequestForModel(spec: ModelSpec, params: AIMessageParams): RequestNormalizationResult {
  const tools = Array.isArray(params.tools) ? params.tools : []
  const maxTools = spec.maxTools

  if (maxTools === undefined || tools.length <= maxTools) {
    return { ok: true, value: { params } }
  }

  const protectedNames = protectedToolNames(params)
  // Only protected names this request actually exposes consume capacity. A
  // transcript can name tools that are not in this turn's surface (role/mode
  // scoping, read-only turns, registry churn); refusing a model for tools it
  // was never going to be sent would recreate the outage this exists to stop.
  const requiredCount = tools.reduce((count, tool) => (protectedNames.has(toolName(tool)) ? count + 1 : count), 0)
  if (requiredCount > maxTools) {
    return {
      ok: false,
      missing: 'tool_capacity',
      detail: `Request requires ${requiredCount} already-referenced/forced tools but ${spec.provider}/${spec.id} accepts at most ${maxTools}.`,
    }
  }

  const selected = selectToolsForLimit(tools, maxTools, params, protectedNames)
  return {
    ok: true,
    value: {
      params: { ...params, tools: selected },
      detail: `adapted tool surface ${tools.length}->${selected.length} for ${spec.provider}/${spec.id}`,
    },
  }
}

/**
 * Tools already named in conversation history or forced by tool_choice are
 * continuity requirements, not candidates for pruning. Removing one can make
 * the next provider see a tool-use transcript whose definition no longer
 * exists, which is a semantic change rather than normalization.
 */
function protectedToolNames(params: AIMessageParams): Set<string> {
  const names = new Set<string>()
  const choice = params.tool_choice as unknown
  if (choice && typeof choice === 'object') {
    const typed = choice as { type?: string; name?: string }
    if (typed.type === 'tool' && typeof typed.name === 'string') names.add(typed.name)
  }

  for (const message of params.messages ?? []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const typed = block as { type?: string; name?: string }
      if (typed.type === 'tool_use' && typeof typed.name === 'string') names.add(typed.name)
    }
  }
  return names
}

function selectToolsForLimit(
  tools: RequestTool[],
  limit: number,
  params: AIMessageParams,
  protectedNames: Set<string>
): RequestTool[] {
  const queryTerms = requestTerms(params)
  const ranked = tools.map((tool, index) => ({
    tool,
    index,
    protected: protectedNames.has(toolName(tool)),
    score: relevanceScore(tool, queryTerms),
  }))

  const keep = new Set<number>()
  for (const item of ranked) if (item.protected) keep.add(item.index)

  const remaining = ranked
    .filter((item) => !item.protected)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  for (const item of remaining) {
    if (keep.size >= limit) break
    keep.add(item.index)
  }

  // Preserve registry/request order after selection. Stable ordering keeps
  // prompt caching predictable and avoids turning provider adaptation into a
  // hidden behavioral signal to the model.
  return tools.filter((_, index) => keep.has(index))
}

function requestTerms(params: AIMessageParams): Set<string> {
  const parts: string[] = []
  const messages = params.messages ?? []

  // The newest user turn is the strongest signal for which capabilities are
  // useful now. Include up to the last three user turns so short follow-ups
  // like "do that" retain subject context without scoring the entire thread.
  let seenUsers = 0
  for (let i = messages.length - 1; i >= 0 && seenUsers < 3; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    seenUsers++
    parts.push(textFromContent(message.content))
  }

  return tokenize(parts.join(' '))
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const typed = block as { type?: string; text?: string; content?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') return typed.text
      if (typed.type === 'tool_result') return textFromContent(typed.content)
      return ''
    })
    .join(' ')
}

function relevanceScore(tool: RequestTool, queryTerms: Set<string>): number {
  if (queryTerms.size === 0) return 0
  const nameTerms = tokenize(toolName(tool).replace(/_/g, ' '))
  const descriptionTerms = tokenize(toolDescription(tool))
  const schemaTerms = tokenize(JSON.stringify(tool))

  let score = 0
  for (const term of queryTerms) {
    if (nameTerms.has(term)) score += 8
    if (descriptionTerms.has(term)) score += 3
    if (schemaTerms.has(term)) score += 1
  }
  return score
}

function toolName(tool: RequestTool): string {
  const name = (tool as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

function toolDescription(tool: RequestTool): string {
  const description = (tool as { description?: unknown }).description
  return typeof description === 'string' ? description : ''
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from', 'give', 'i', 'if', 'in', 'is',
  'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'what', 'whether', 'with', 'you', 'your',
])

function tokenize(value: string): Set<string> {
  const out = new Set<string>()
  for (const raw of value.toLowerCase().split(/[^a-z0-9]+/g)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}
