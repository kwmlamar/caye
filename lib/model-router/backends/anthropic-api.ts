import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { providerAdapter } from '@/lib/ai/providers'
import { asAnthropicTool } from '@/lib/caye-agent/tools/types'
import type { BackendHealth, ModelInvokeRequest, ModelInvokeResult } from '../types'
import type { ToolCapableBackend, ToolTurnRequest, ToolTurnResult } from '../tool-bridge/types'

/**
 * The normal metered API path — same ANTHROPIC_API_KEY and the same
 * loggedMessagesCreate telemetry wrapper every other call site in the repo
 * uses, so spend still shows up in llm_call_log under one consistent
 * source tag. Deliberately a NEW, isolated call site rather than a change
 * to lib/caye-agent/execute.ts — that function is shared with live
 * customer Zoho front-desk traffic (see the audit report, Q10), and this
 * backend must not touch that blast radius.
 */
const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 4096

export class AnthropicApiBackend implements ToolCapableBackend {
  readonly id = 'anthropic_api' as const
  readonly provider = 'anthropic' as const
  readonly authMode = 'api_key' as const
  readonly capabilities = [
    'general_reasoning',
    'coding',
    'tool_use',
    'long_context',
    'vision',
    'structured_output',
    'persisted_session',
  ] as const

  async checkHealth(): Promise<BackendHealth> {
    const checkedAt = new Date().toISOString()
    if (!providerAdapter('anthropic').hasCredentials()) {
      return { state: 'auth_required', detail: 'Anthropic is not configured in the Caye AI gateway.', checkedAt }
    }
    return { state: 'available', checkedAt }
  }

  async invoke(req: ModelInvokeRequest, signal: AbortSignal): Promise<ModelInvokeResult> {
    const start = Date.now()

    const response = await loggedMessagesCreate(
      null,
      {
        model: MODEL,
        max_tokens: req.maxOutputTokens ?? MAX_TOKENS,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.text })),
      },
      {
        source: 'lib/model-router/backends/anthropic-api.ts:invoke',
        task: 'operator_response',
        // This backend exists so Caye Direct's founder-facing router can pick
        // Anthropic *specifically*. Pin it: the outer router owns fallback
        // here, and silently answering an explicit vendor choice with a
        // different vendor would make that surface lie.
        pinProvider: 'anthropic',
        workspaceId: req.ctx.workspaceId,
      },
      { signal }
    )

    const latencyMs = Date.now() - start
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')

    return {
      backend: 'anthropic_api',
      model: response.model,
      text: textBlock?.text ?? '',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      latencyMs,
    }
  }

  /**
   * Native Anthropic tool-calling — zero translation. Same asAnthropicTool
   * mapping and same cache_control-on-last-tool pattern runToolLoop uses.
   * The stable tool schema keeps a 1h TTL; the request-varying Caye Direct
   * system prompt uses 5m so fast multi-turn tool loops still hit cache
   * without paying the 1h write premium for context that changes between
   * human turns.
   */
  async invokeTurn(req: ToolTurnRequest, signal: AbortSignal): Promise<ToolTurnResult> {
    const start = Date.now()

    const tools = req.tools.map(asAnthropicTool)
    if (tools.length > 0) {
      tools[tools.length - 1] = {
        ...tools[tools.length - 1],
        cache_control: { type: 'ephemeral', ttl: '1h' },
      } as Anthropic.Tool
    }

    const response = await loggedMessagesCreate(
      null,
      {
        model: MODEL,
        max_tokens: req.maxOutputTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral', ttl: '5m' } }],
        messages: req.messages,
        tools,
      },
      {
        source: 'lib/model-router/backends/anthropic-api.ts:invokeTurn',
        task: 'agent_planning',
        pinProvider: 'anthropic',
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
