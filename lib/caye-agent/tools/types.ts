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
 * - driver: guide/driver dispatched a specific booking (2026-07-05, driver
 *   dispatch feature). Zero back-office tool grants — only tools tagged
 *   modes: ['driver'] accept this role, and those are read-only + a
 *   single escalate-to-owner tool. Never gets 'staff'-shaped access.
 *
 * Cron-driven system invocations (briefings, EOD summaries) use 'founder'
 * since they have no human caller and need access to every tool.
 */
export type Role = 'owner' | 'staff' | 'founder' | 'driver'

/**
 * Which Caye surface a tool is available on (#56).
 *
 * - back-office: the operator-facing agent (WhatsApp pings, briefings,
 *   EOD summaries) — the existing TOOL_REGISTRY surface.
 * - front-desk: the customer-facing reply path in lib/caye-reply.ts.
 *   Front-desk tools currently live inline in caye-reply.ts and are
 *   NOT in TOOL_REGISTRY yet (cross-registry unification is #14).
 * - driver: guide/driver-facing agent (2026-07-05). Narrow surface —
 *   read-only booking/logistics lookups scoped to the caller's own
 *   assignment, plus an escalate-to-owner tool. Never shares tools with
 *   back-office.
 *
 * runToolLoop filters TOOL_REGISTRY by the request's mode so the API
 * call only ships the tool schemas relevant to the current surface,
 * dropping input tokens per request. Tools tagged with both modes are
 * cross-cutting (e.g. escalate_to_team eventually).
 */
export type ToolMode = 'front-desk' | 'back-office' | 'driver'

export interface ToolContext {
  workspaceId: string
  /** Caller role. Cron paths pass 'founder' (system invocation). */
  callerRole: Role
  /**
   * Caller's E.164 phone as seen by the webhook. Only meaningfully used
   * by driver-mode tools (2026-07-05) to scope "my assigned booking" —
   * back-office tools identify the caller via callerRole/operatorId
   * instead and can ignore this field.
   */
  callerPhone?: string | null
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
  /**
   * Which Caye surfaces this tool is available on (#56). runToolLoop
   * filters TOOL_REGISTRY by request mode before shipping schemas to
   * Claude. All v1 back-office tools are tagged ['back-office']; future
   * cross-cutting tools can declare both.
   */
  modes: ToolMode[]
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
