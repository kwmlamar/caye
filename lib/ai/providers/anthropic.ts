import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { classifyAIError } from '../errors'
import { modelCanServe } from '../capabilities'
import { findModelByProviderId } from '../models'
import type { AIMessageParams, AIProviderAdapter, AIResponseMessage } from '../types'

/**
 * Anthropic adapter.
 *
 * This is the ONLY module in Caye that constructs an Anthropic client at
 * runtime. Caye's canonical request shape is already Anthropic-schema'd, so
 * this adapter is a pass-through — which is the point: the cheapest adapter
 * is the one for the dialect you already speak, and the translation cost is
 * paid once, in openai-translate.ts, by the providers that differ.
 */
export class AnthropicAdapter implements AIProviderAdapter {
  readonly id = 'anthropic' as const

  private client: Anthropic | null = null
  private clientKey: string | null = null

  hasCredentials(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY)
  }

  credentialFingerprint(): string {
    return fingerprint(process.env.ANTHROPIC_API_KEY)
  }

  supports(params: AIMessageParams, model: string) {
    const spec = findModelByProviderId('anthropic', model)
    // An id outside the catalogue is a deliberate caller override; trust it
    // rather than blocking the request on our own table being stale.
    return spec ? modelCanServe(spec, params) : ({ ok: true } as const)
  }

  async generate(params: AIMessageParams, model: string, signal?: AbortSignal): Promise<AIResponseMessage> {
    const client = this.getClient()
    return client.messages.create({ ...params, model, stream: false }, signal ? { signal } : undefined)
  }

  classifyError(error: unknown) {
    return classifyAIError(error, 'anthropic')
  }

  /** Rebuilt when the key rotates so a restart isn't needed to recover. */
  private getClient(): Anthropic {
    const key = process.env.ANTHROPIC_API_KEY
    if (!this.client || this.clientKey !== key) {
      this.client = new Anthropic({ apiKey: key })
      this.clientKey = key ?? null
    }
    return this.client
  }
}

/** Non-reversible, non-identifying. Only ever compared to itself. */
export function fingerprint(secret: string | undefined): string {
  if (!secret) return 'absent'
  let hash = 5381
  for (let i = 0; i < secret.length; i++) hash = ((hash << 5) + hash + secret.charCodeAt(i)) | 0
  return `len${secret.length}:${(hash >>> 0).toString(36)}`
}
