import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * Risk tier locked in grill-me Q2: read/low execute autonomously,
 * high triggers a confirmation step (sliced into #42 onward).
 */
export type ToolRisk = 'read' | 'low' | 'high'

export interface ToolContext {
  workspaceId: string
}

/**
 * Structured tool output. Stringified and handed back to Claude in a
 * tool_result block. ok=true means tool succeeded; data is the
 * structured response. ok=false means tool failed; error is a short
 * human-readable message Caye can pass to the operator.
 */
export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface Tool<T = unknown> {
  name: string
  description: string
  inputSchema: Anthropic.Tool['input_schema']
  risk: ToolRisk
  execute: (args: T, ctx: ToolContext) => Promise<ToolResult>
}

/**
 * Strip the runtime-only fields and return what Claude's API needs.
 */
export function asAnthropicTool(tool: Tool<never>): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}
