import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * Risk tier locked in grill-me Q2: read/low execute autonomously,
 * high triggers a confirmation step (sliced into #42 onward).
 */
export type ToolRisk = 'read' | 'low' | 'high'

/**
 * Caller roles plumbed from the operator_allowlist table through the
 * webhook → cayeAgent → runToolLoop → tool.execute path. Locked
 * 2026-06-24 (#48).
 *
 * - owner: workspace owner (the operator named on the customer row).
 * - staff: future per-workspace staff. Schema-only in v1 — no tool
 *   currently grants access to staff. Wired when first customer onboards
 *   staff in conversation via the future add_team_member tool (#55).
 * - founder: TropiTech founder. Default-on every workspace; first-class
 *   support and observability, not a debug back door.
 *
 * Cron-driven system invocations (briefings, EOD summaries) use 'founder'
 * since they have no human caller and need access to every tool.
 */
export type Role = 'owner' | 'staff' | 'founder'

export interface ToolContext {
  workspaceId: string
  /** Caller role. Cron paths pass 'founder' (system invocation). */
  callerRole: Role
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
  /**
   * Roles permitted to invoke this tool. Enforced in runToolLoop before
   * tool.execute runs; non-permitted callers get a structured error in
   * the tool_result so the model can react (apologize, escalate, etc.)
   * rather than failing silently. Locked 2026-06-24 (#48).
   */
  roles: Role[]
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
