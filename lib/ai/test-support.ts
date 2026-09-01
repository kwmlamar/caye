import type { AICapability, AIMessageParams, AIProviderAdapter, AIProviderId, AIResponseMessage } from './types'
import { AIProviderError } from './types'
import { classifyAIError } from './errors'

/**
 * Test doubles for the gateway. Kept out of a .test.ts file so several
 * suites can share one honest fake instead of each inventing its own
 * slightly-different provider.
 */

export function textResponse(text: string, model = 'fake-model', usage = { input: 10, output: 5 }): AIResponseMessage {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as unknown as AIResponseMessage
}

export interface FakeProviderOptions {
  hasKey?: boolean
  /** Per-call behaviour, consumed in order; the last entry repeats. */
  behaviour?: (('ok' | Error)[]) | (() => AIResponseMessage)
  capabilities?: readonly AICapability[]
  fingerprint?: string
}

export class FakeProvider implements AIProviderAdapter {
  calls: { params: AIMessageParams; model: string }[] = []
  private queue: ('ok' | Error)[]

  constructor(readonly id: AIProviderId, private readonly opts: FakeProviderOptions = {}) {
    this.queue = Array.isArray(opts.behaviour) ? [...opts.behaviour] : ['ok']
  }

  hasCredentials(): boolean {
    return this.opts.hasKey !== false
  }

  credentialFingerprint(): string {
    return this.opts.fingerprint ?? `fake-${this.id}`
  }

  supports(params: AIMessageParams): { ok: true } | { ok: false; missing: AICapability } {
    const caps = this.opts.capabilities
    if (!caps) return { ok: true }
    if (Array.isArray(params.tools) && params.tools.length > 0 && !caps.includes('tool_use')) {
      return { ok: false, missing: 'tool_use' }
    }
    return { ok: true }
  }

  async generate(params: AIMessageParams, model: string): Promise<AIResponseMessage> {
    this.calls.push({ params, model })
    const next = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]
    if (next instanceof Error) throw next
    return textResponse(`${this.id} answered`, model)
  }

  /** Same shared classifier the real adapters use — a double that classified
   *  differently would test the double, not the policy. */
  classifyError(error: unknown): AIProviderError {
    return classifyAIError(error, this.id)
  }
}

export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}
