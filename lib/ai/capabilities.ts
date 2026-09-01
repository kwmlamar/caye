import 'server-only'
import { modelSupports, type ModelSpec } from './models'
import type { AICapability, AIMessageParams } from './types'

/**
 * What a request actually needs, read off the request itself rather than
 * declared by the caller. A caller that forgets to say "this has an image"
 * would otherwise get routed to a text-only fallback and receive a confident
 * answer about an image the model never saw — a silent correctness failure,
 * which is worse than a routing error.
 */
export function requiredCapabilities(params: AIMessageParams): AICapability[] {
  const required: AICapability[] = []
  if (Array.isArray(params.tools) && params.tools.length > 0) required.push('tool_use')
  if ((params as { stream?: boolean }).stream) required.push('streaming')
  if (hasImageContent(params)) required.push('vision')
  return required
}

function hasImageContent(params: AIMessageParams): boolean {
  for (const message of params.messages ?? []) {
    const content = message.content
    if (typeof content === 'string' || !Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const type = (block as { type?: string }).type
      if (type === 'image' || type === 'document') return true
      // Tool results can nest image blocks (artifact understanding path).
      if (type === 'tool_result') {
        const nested = (block as { content?: unknown }).content
        if (Array.isArray(nested) && nested.some((b) => (b as { type?: string })?.type === 'image')) return true
      }
    }
  }
  return false
}

/**
 * Deliberately crude token estimate — 3.5 chars/token is close enough to
 * catch "this 300k-token request cannot go to a 128k fallback", which is the
 * only decision it is used for. It never rejects the primary route; it only
 * prevents routing to a model that provably cannot hold the request.
 */
export function estimateRequestTokens(params: AIMessageParams): number {
  let chars = 0
  const system = params.system
  if (typeof system === 'string') chars += system.length
  else if (Array.isArray(system)) for (const block of system) chars += JSON.stringify(block).length
  for (const message of params.messages ?? []) chars += JSON.stringify(message.content ?? '').length
  if (Array.isArray(params.tools)) for (const tool of params.tools) chars += JSON.stringify(tool).length
  return Math.ceil(chars / 3.5)
}

export function modelCanServe(
  spec: ModelSpec,
  params: AIMessageParams
): { ok: true } | { ok: false; missing: AICapability } {
  for (const capability of requiredCapabilities(params)) {
    if (!modelSupports(spec, capability)) return { ok: false, missing: capability }
  }
  // Provider tool-array caps. Checked before spending a request: OpenAI
  // answers an over-cap tools array with a 400, which costs a round-trip and
  // (before this was modelled) looked like a malformed request rather than a
  // provider limit. Skipping here routes straight to a provider that can.
  const toolCount = Array.isArray(params.tools) ? params.tools.length : 0
  if (spec.maxTools !== undefined && toolCount > spec.maxTools) {
    return { ok: false, missing: 'tool_capacity' }
  }
  const needed = estimateRequestTokens(params) + (params.max_tokens ?? spec.defaultMaxOutputTokens)
  if (needed > spec.contextWindow) return { ok: false, missing: 'long_context' }
  return { ok: true }
}
