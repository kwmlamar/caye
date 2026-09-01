import 'server-only'
import { AnthropicAdapter } from './anthropic'
import { OpenAIAdapter, OpenRouterAdapter } from './openai-compatible'
import type { AIProviderAdapter, AIProviderId } from '../types'

/**
 * Adapter registry. Adapters are stateless apart from a cached HTTP client,
 * so one instance per process is correct and avoids rebuilding a client per
 * request. Injectable for tests via `setProviderAdapters`.
 */
let adapters: Record<AIProviderId, AIProviderAdapter> = {
  anthropic: new AnthropicAdapter(),
  openai: new OpenAIAdapter(),
  openrouter: new OpenRouterAdapter(),
}

export function providerAdapter(id: AIProviderId): AIProviderAdapter {
  return adapters[id]
}

export function allProviderAdapters(): AIProviderAdapter[] {
  return Object.values(adapters)
}

/** Test seam. Returns a restore function so suites cannot leak state. */
export function setProviderAdapters(next: Partial<Record<AIProviderId, AIProviderAdapter>>): () => void {
  const previous = adapters
  adapters = { ...adapters, ...next }
  return () => {
    adapters = previous
  }
}

export { AnthropicAdapter, OpenAIAdapter, OpenRouterAdapter }
