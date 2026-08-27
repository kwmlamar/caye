import 'server-only'
import { logGenericLlmUsage } from '@/lib/llm-telemetry'
import type { BackendHealth, ModelInvokeRequest, ModelInvokeResult } from '../types'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from '../tool-bridge/types'

type Config = {
  id: 'openai_api' | 'openrouter'
  keyName: 'OPENAI_API_KEY' | 'OPENROUTER_API_KEY'
  baseUrl: string
  model: string
  provider: 'openai' | 'openrouter'
}

type Usage = { inputTokens?: number; outputTokens?: number }

/** Small native OpenAI-compatible adapter. It owns no routing policy. */
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
    return process.env[this.config.keyName]
      ? { state: 'available', checkedAt }
      : { state: 'auth_required', detail: `${this.config.keyName} is not set.`, checkedAt }
  }

  async invoke(req: ModelInvokeRequest, signal: AbortSignal): Promise<ModelInvokeResult> {
    const start = Date.now()
    const json = await this.call(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages.map((m) => ({ role: m.role, content: m.text })),
        ],
        max_tokens: req.maxOutputTokens ?? 4096,
      },
      signal
    )
    const callUsage = usage(json)
    this.logUsage(json.model ?? this.config.model, callUsage, req.ctx.workspaceId, 'invoke')
    return {
      backend: this.id,
      model: json.model,
      text: json.choices?.[0]?.message?.content ?? '',
      usage: callUsage,
      latencyMs: Date.now() - start,
    }
  }

  async invokeTurn(req: ToolTurnRequest, signal: AbortSignal): Promise<ToolTurnResult> {
    const start = Date.now()
    const tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
    const json = await this.call(
      {
        model: this.config.model,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          })),
        ],
        tools,
        max_tokens: req.maxOutputTokens,
      },
      signal
    )
    const callUsage = usage(json)
    this.logUsage(json.model ?? this.config.model, callUsage, req.ctx.workspaceId, 'invokeTurn')

    const message = json.choices?.[0]?.message ?? {}
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (calls.length) {
      return {
        content: calls.map((c: any, i: number) => ({
          type: 'tool_use' as const,
          id: c.id ?? `${this.id}_${start}_${i}`,
          name: c.function?.name ?? '',
          input: safeJson(c.function?.arguments),
          caller: { type: 'direct' as const },
        })),
        model: json.model,
        usage: callUsage,
        latencyMs: Date.now() - start,
        toolCallsFromStructuredText: false,
      }
    }
    return {
      content: [{ type: 'text', text: typeof message.content === 'string' ? message.content : '', citations: null }],
      model: json.model,
      usage: callUsage,
      latencyMs: Date.now() - start,
      toolCallsFromStructuredText: false,
    }
  }

  private async call(body: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    const key = process.env[this.config.keyName]
    if (!key) throw Object.assign(new Error(`${this.config.keyName} is not set`), { status: 401 })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }
    // OpenRouter privacy default: do not allow provider data collection. Model choice remains explicit/configured.
    if (this.id === 'openrouter') Object.assign(body, { provider: { data_collection: 'deny' } })

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const error = new Error(`Provider request failed (${response.status})`)
      ;(error as any).status = response.status
      throw error
    }
    return response.json()
  }

  private logUsage(model: string, callUsage: Usage, workspaceId: string | null | undefined, method: 'invoke' | 'invokeTurn') {
    void logGenericLlmUsage(
      { model, ...callUsage },
      {
        source: `lib/model-router/backends/openai-compatible.ts:${this.id}:${method}`,
        workspaceId,
      }
    ).catch((err) => console.error('[model-router/openai-compatible] usage log failed:', err))
  }
}

const safeJson = (s: unknown): Record<string, unknown> => {
  try {
    const x = JSON.parse(typeof s === 'string' ? s : '{}')
    return x && typeof x === 'object' && !Array.isArray(x) ? x : {}
  } catch {
    return {}
  }
}

const usage = (j: any): Usage => ({
  inputTokens: j.usage?.prompt_tokens,
  outputTokens: j.usage?.completion_tokens,
})

export const OpenAIApiBackend = class extends OpenAICompatibleBackend {
  constructor() {
    super({
      id: 'openai_api',
      keyName: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
      model: process.env.OPENAI_API_MODEL || 'gpt-4.1',
      provider: 'openai',
    })
  }
}

export const OpenRouterBackend = class extends OpenAICompatibleBackend {
  constructor() {
    super({
      id: 'openrouter',
      keyName: 'OPENROUTER_API_KEY',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
      provider: 'openrouter',
    })
  }
}
