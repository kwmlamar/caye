import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import type { Tool } from '@/lib/caye-agent/tools/types'
import type { FounderRouterContext, ModelBackend, RouterTaskHints } from '../types'

/**
 * A backend that can participate in Caye's real tool loop, not just plain
 * reasoning. `invokeTurn` returns Anthropic.ContentBlock[] regardless of
 * which provider actually answered — anthropic_api returns its native
 * response.content untouched; the CLI subscription backends synthesize
 * the same shape from their own structured-output protocol (see
 * claude-subscription.ts / openai-codex-subscription.ts). This is the
 * ONE seam where providers differ; founder-tool-loop.ts and everything
 * downstream of it (tool execution, action grounding, persistence) never
 * has to know which backend produced a given round.
 */
export interface ToolCapableBackend extends ModelBackend {
  invokeTurn(req: ToolTurnRequest, signal: AbortSignal): Promise<ToolTurnResult>
}

export interface ToolTurnRequest {
  ctx: FounderRouterContext
  system: string
  /** Caye's canonical wire format — same type persisted to caye_operator_messages.claude_format. */
  messages: Anthropic.MessageParam[]
  /** Real, mode-filtered TOOL_REGISTRY entries — never a bridge-owned copy. */
  tools: Tool<never>[]
  maxOutputTokens: number
  hints?: RouterTaskHints
}

export interface ToolTurnResult {
  content: Anthropic.ContentBlock[]
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  latencyMs: number
  /**
   * true when this backend derived tool_use blocks by parsing structured
   * text/JSON output rather than native API tool-calling. Observability
   * only — never changes gating, validation, or execution, which treat
   * every backend's tool_use blocks identically once produced.
   */
  toolCallsFromStructuredText?: boolean
}
