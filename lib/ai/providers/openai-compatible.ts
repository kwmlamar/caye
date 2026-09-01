import 'server-only'
import { AIProviderError, type AIMessageParams, type AIProviderAdapter, type AIProviderId, type AIResponseMessage } from '../types'
import { classifyAIError } from '../errors'
import { modelCanServe } from '../capabilities'
import { findModelByProviderId } from '../models'
import { fromOpenAiResponse, toOpenAiMessages, toOpenAiTools, toOpenAiToolChoice } from './openai-translate'
import { fingerprint } from './anthropic'

const REQUEST_TIMEOUT_MS = Number(process.env.CAYE_AI_REQUEST_TIMEOUT_MS || 120_000)

interface Config {
  id: Extract<AIProviderId, 'openai' | 'openrouter'>
  keyName: 'OPENAI_API_KEY' | 'OPENROUTER_API_KEY'
  baseUrl: string
}

/**
 * OpenAI Chat Completions adapter, shared by OpenAI and OpenRouter (which
 * serves the same wire protocol). Anthropic-only request fields —
 * `cache_control`, `betas`, `thinking`, `container` — are dropped here rather
 * than at call sites: a prompt-caching directive is an Anthropic
 * optimisation, and forwarding it would be a 400.
 */
export class OpenAICompatibleAdapter implements AIProviderAdapter {
  readonly id: Config['id']

  constructor(private readonly config: Config) {
    this.id = config.id
  }

  hasCredentials(): boolean {
    return Boolean(process.env[this.config.keyName])
  }

  credentialFingerprint(): string {
    return fingerprint(process.env[this.config.keyName])
  }

  supports(params: AIMessageParams, model: string) {
    const spec = findModelByProviderId(this.id, model)
    return spec ? modelCanServe(spec, params) : ({ ok: true } as const)
  }

  async generate(params: AIMessageParams, model: string, signal?: AbortSignal): Promise<AIResponseMessage> {
    const key = process.env[this.config.keyName]
    if (!key) {
      throw new AIProviderError('authentication', `${this.config.keyName} is not set`, { provider: this.id, model })
    }

    const tools = toOpenAiTools(params.tools)
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAiMessages(params),
      ...outputTokenLimit(this.id, model, params.max_tokens ?? 4096),
      ...(tools ? { tools } : {}),
      ...(tools && params.tool_choice ? { tool_choice: toOpenAiToolChoice(params.tool_choice) } : {}),
      ...(typeof params.temperature === 'number' && !isReasoningModel(model) ? { temperature: params.temperature } : {}),
      ...reasoningControls(this.id, model, params.max_tokens ?? 4096),
    }
    // OpenRouter: never let a fallback provider retain Caye's customer data.
    if (this.id === 'openrouter') body.provider = { data_collection: 'deny' }

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = signal ? anySignal([signal, timeout]) : timeout

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: combined,
    })

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 1000)
      throw classifyAIError(
        Object.assign(new Error(`${this.id} request failed (${response.status}): ${detail}`), {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        }),
        this.id,
        model
      )
    }

    const json = (await response.json()) as Record<string, unknown>
    // A 200 that carries an error body is an OpenRouter upstream failure.
    if (json && typeof json === 'object' && 'error' in json && !('choices' in json)) {
      throw classifyAIError(json, this.id, model)
    }
    return fromOpenAiResponse(json as Record<string, any>, model)
  }

  classifyError(error: unknown) {
    return classifyAIError(error, this.id)
  }
}

/** GPT-5-class models reject `max_tokens` in favour of `max_completion_tokens`. */
export function outputTokenLimit(provider: AIProviderId, model: string, tokens: number): Record<string, number> {
  return provider === 'openai' && isReasoningModel(model) ? { max_completion_tokens: tokens } : { max_tokens: tokens }
}

export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/.test(model)
}

/**
 * Hidden reasoning is billed against the same completion budget on
 * GPT-5-class Chat Completions, so a small budget can be fully consumed
 * before any visible text is emitted. Preserved verbatim from the existing
 * model-router adapter — this is a live-observed dead-air fix, not a guess.
 */
function reasoningControls(provider: AIProviderId, model: string, maxOutputTokens: number): Record<string, string> {
  if (provider === 'openai' && model.startsWith('gpt-5') && maxOutputTokens <= 2000) {
    return { reasoning_effort: 'minimal' }
  }
  return {}
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const withAny = AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  if (typeof withAny.any === 'function') return withAny.any(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({ id: 'openai', keyName: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' })
  }
}

export class OpenRouterAdapter extends OpenAICompatibleAdapter {
  constructor() {
    super({ id: 'openrouter', keyName: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1' })
  }
}
