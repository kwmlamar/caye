import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { providerAdapter } from '@/lib/ai/providers'
import { asAnthropicTool } from '@/lib/caye-agent/tools/types'
import type { BackendHealth, ModelInvokeRequest, ModelInvokeResult } from '../types'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from '../tool-bridge/types'

type Config = {
  id: 'openai_api' | 'openrouter'
  model: string
  provider: 'openai' | 'openrouter'
}

/**
 * Caye Direct's API-key backends preserve the model-router's provider-specific
 * selection semantics while sending every completion through the canonical
 * Caye AI gateway. Credentials, retries, timeout, translation, routing
 * telemetry, and provider error normalization therefore stay at that boundary.
 */
export class OpenAICompatibleBackend implements ToolCapableBackend {
  readonly id: Config['id']
  readonly provider: Config['provider']
  readonly authMode = 'api_key' as const
  readonly capabilities = ['general_reasoning', 'coding', 'tool_use', 'structured_output', 'vision'] as const

  constructor(private readonly config: Config) {
    this.id = config.id
    this.provider = config.provider
  }

  async checkHealth(): Promise<BackendHealth> {
    const checkedAt = new Date().toISOString()
    return providerAdapter(this.provider).hasCredentials()
      ? { state: 'available', checkedAt }
      : { state: 'auth_required', detail: `${this.provider} is not configured in the Caye AI gateway.`, checkedAt }
  }

  async invoke(req: ModelInvokeRequest, signal: AbortSignal): Promise<ModelInvokeResult> {
    const start = Date.now()
    const response = await loggedMessagesCreate(
      null,
      {
        model: this.config.model,
        max_tokens: req.maxOutputTokens ?? 4096,
        system: req.system,
        messages: req.messages.map((message) => ({ role: message.role, content: message.text })),
      },
      {
        source: `lib/model-router/backends/openai-compatible.ts:${this.id}:invoke`,
        task: 'operator_response',
        pinProvider: this.provider,
        workspaceId: req.ctx.workspaceId,
      },
      { signal }
    )

    return {
      backend: this.id,
      model: response.model,
      text: textFrom(response.content),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      latencyMs: Date.now() - start,
    }
  }

  async invokeTurn(req: ToolTurnRequest, signal: AbortSignal): Promise<ToolTurnResult> {
    const start = Date.now()
    const response = await loggedMessagesCreate(
      null,
      {
        model: this.config.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: req.messages,
        tools: req.tools.map(asAnthropicTool),
      },
      {
        source: `lib/model-router/backends/openai-compatible.ts:${this.id}:invokeTurn`,
        task: 'agent_planning',
        pinProvider: this.provider,
        workspaceId: req.ctx.workspaceId,
      },
      { signal }
    )

    return {
      content: response.content,
      model: response.model,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      latencyMs: Date.now() - start,
      toolCallsFromStructuredText: false,
    }
  }
}

function textFrom(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export const OpenAIApiBackend = class extends OpenAICompatibleBackend {
  constructor() {
    super({ id: 'openai_api', model: process.env.OPENAI_API_MODEL || 'gpt-5-mini', provider: 'openai' })
  }
}

export const OpenRouterBackend = class extends OpenAICompatibleBackend {
  constructor() {
    super({ id: 'openrouter', model: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini', provider: 'openrouter' })
  }
}
