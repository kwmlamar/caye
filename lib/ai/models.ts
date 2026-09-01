import 'server-only'
import type { AICapability, AIProviderId } from './types'

/**
 * THE model catalogue. Every model id Caye can send traffic to lives here
 * and nowhere else.
 *
 * Before this file, 42 model strings were inlined across app/ and lib/,
 * which meant "what is Caye actually running on" could only be answered by
 * grepping, and a model deprecation was a 42-file change. Feature code now
 * names a *task*; lib/ai/routes.ts maps that to entries below.
 *
 * Cost tiers are relative, not absolute: `strong` is the quality tier for
 * customer-visible generation and real reasoning, `cheap` is for
 * high-volume classification/extraction where a smaller model is honestly
 * good enough. See lib/llm-pricing.ts for the actual dollar table.
 */
export type ModelTier = 'strong' | 'cheap'

export interface ModelSpec {
  /** Provider-native id, exactly as sent on the wire. */
  id: string
  provider: AIProviderId
  tier: ModelTier
  capabilities: readonly AICapability[]
  /** Total context window in tokens. Used to skip a fallback that cannot hold the request. */
  contextWindow: number
  /** Default ceiling when a caller does not specify max_tokens. */
  defaultMaxOutputTokens: number
  /**
   * Hard cap on the number of tool definitions the provider accepts in one
   * request, when it has one. Omitted means "no cap we know of".
   *
   * OpenAI rejects a 129-tool request with HTTP 400 `array_above_max_length`.
   * That is a provider limit, not a broken request: on 2026-09-01 the founder
   * back-office surface (129 tools) was served fine by Anthropic, refused by
   * OpenAI, and — verified against the live API — accepted by OpenRouter. So
   * this is modelled per-model and routed around, never treated as a Caye bug.
   */
  maxTools?: number
}

const FULL: readonly AICapability[] = ['tool_use', 'structured_output', 'vision', 'streaming', 'long_context'] as const

/**
 * OpenRouter model ids are deployment-tunable because the catalogue there
 * moves faster than Caye ships. Defaults preserve the id this repo already
 * used (`openai/gpt-4.1-mini`, lib/model-router/backends/openai-compatible.ts)
 * so nothing about the existing fallback changes silently.
 */
/**
 * OpenAI's documented/observed ceiling on the `tools` array. Kept as a named
 * constant so raising it is a one-line, reviewable change if OpenAI does.
 */
const OPENAI_MAX_TOOLS = 128

const OPENROUTER_STRONG = process.env.OPENROUTER_STRONG_MODEL || process.env.OPENROUTER_MODEL || 'openai/gpt-4.1'
const OPENROUTER_CHEAP = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini'

export const MODELS = {
  anthropic_strong: {
    id: process.env.ANTHROPIC_STRONG_MODEL || 'claude-sonnet-4-6',
    provider: 'anthropic',
    tier: 'strong',
    capabilities: FULL,
    contextWindow: 200_000,
    defaultMaxOutputTokens: 4096,
  },
  anthropic_cheap: {
    id: process.env.ANTHROPIC_CHEAP_MODEL || 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    tier: 'cheap',
    capabilities: FULL,
    contextWindow: 200_000,
    defaultMaxOutputTokens: 4096,
  },
  openai_strong: {
    id: process.env.OPENAI_STRONG_MODEL || 'gpt-5',
    provider: 'openai',
    tier: 'strong',
    capabilities: ['tool_use', 'structured_output', 'vision', 'streaming', 'long_context'],
    contextWindow: 400_000,
    defaultMaxOutputTokens: 4096,
    maxTools: OPENAI_MAX_TOOLS,
  },
  openai_cheap: {
    id: process.env.OPENAI_API_MODEL || process.env.OPENAI_CHEAP_MODEL || 'gpt-5-mini',
    provider: 'openai',
    tier: 'cheap',
    capabilities: ['tool_use', 'structured_output', 'vision', 'streaming', 'long_context'],
    contextWindow: 400_000,
    defaultMaxOutputTokens: 4096,
    maxTools: OPENAI_MAX_TOOLS,
  },
  openrouter_strong: {
    id: OPENROUTER_STRONG,
    provider: 'openrouter',
    tier: 'strong',
    capabilities: ['tool_use', 'structured_output', 'vision', 'streaming', 'long_context'],
    contextWindow: 128_000,
    defaultMaxOutputTokens: 4096,
  },
  openrouter_cheap: {
    id: OPENROUTER_CHEAP,
    provider: 'openrouter',
    tier: 'cheap',
    capabilities: ['tool_use', 'structured_output', 'vision', 'streaming', 'long_context'],
    contextWindow: 128_000,
    defaultMaxOutputTokens: 4096,
  },
} as const satisfies Record<string, ModelSpec>

export type ModelKey = keyof typeof MODELS

export function modelSpec(key: ModelKey): ModelSpec {
  return MODELS[key]
}

/** Reverse lookup for telemetry/admin display. Returns null for an unknown id. */
export function findModelByProviderId(provider: AIProviderId, id: string): ModelSpec | null {
  for (const spec of Object.values(MODELS) as ModelSpec[]) {
    if (spec.provider === provider && spec.id === id) return spec
  }
  return null
}

export function modelSupports(spec: ModelSpec, capability: AICapability): boolean {
  return spec.capabilities.includes(capability)
}
