import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import type { ToolResult } from './result'
import type { EvidenceFact } from '../evidence'

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
 * - admin-shell: founder-only dev/ops console (2026-07-21), NOT a
 *   variant of back-office. Back-office tools are business-ops (bookings,
 *   customers, voice/services) and workspace-scoped; admin-shell tools
 *   are dev/ops (cron health, manual cron triggers) and workspace-less.
 *   Never shares tools with back-office/front-desk/driver.
 *
 * runToolLoop filters TOOL_REGISTRY by the request's mode so the API
 * call only ships the tool schemas relevant to the current surface,
 * dropping input tokens per request. Tools tagged with both modes are
 * cross-cutting (e.g. escalate_to_team eventually).
 */
export type ToolMode = 'front-desk' | 'back-office' | 'driver' | 'admin-shell'

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
  /**
   * The operator_allowlist.id of the human on the other end, when known.
   * Null for cron-driven system invocations (briefings, EOD summaries)
   * and legacy pre-migration rows. Used by the high-risk confirmation
   * gate (gateHighRisk) to scope staged actions per-operator so two
   * operators sharing a workspace's back-office channel can't confirm
   * or collide on each other's pending actions.
   */
  operatorId?: number | null
  /**
   * The front-desk conversation this invocation is handling (2026-08-16,
   * final pre-canary closure). A real front-desk webhook invocation is
   * always scoped to exactly one customer conversation — this is that
   * conversation's `unified_conversations.id`, known ambient context the
   * SAME way `workspaceId` is, not something a tool needs to be told
   * again via its own arguments. Set by the caller (a webhook route, or
   * the replay/job harness) before runToolLoop runs.
   *
   * Currently read by runToolLoop's front-desk output-safety fallback
   * (execute.ts) to fetch the real thread and run the SAME
   * `unsupportedLogisticsTimeClaims` check `send_customer_reply` runs,
   * closing the parity gap where a zero-tool-use anomaly had no
   * conversation to ground a logistics claim against. `send_customer_reply`
   * itself still takes `conversation_id` as an explicit tool argument
   * (unchanged) — this field doesn't replace that, it exists for the one
   * path (the fallback) that has no tool arguments to read at all.
   * Undefined/null everywhere else (back-office/driver/admin-shell never
   * set it; front-desk call sites that don't set it simply skip the
   * fallback's logistics check rather than guessing).
   */
  conversationId?: string | null
  /**
   * The inbound `unified_messages` row (or provider `channel_message_id`)
   * this front-desk turn is replying to (2026-08-16, final pre-canary
   * closure). Threaded into `dispatchOperatorReply`'s optional
   * idempotency key by `send_customer_reply` so a webhook-level retry of
   * the SAME inbound message — a real, distinct failure mode from the
   * same-turn/same-request retries `gateHighRisk`/`MAX_ATTEMPTS` already
   * cover — collapses onto the one real send instead of sending twice.
   * The WhatsApp webhook already treats a provider `channel_message_id`
   * as the canonical identity of one inbound delivery for its OWN dedup
   * check (`app/api/webhooks/whatsapp/route.ts`); this reuses that same
   * identity for the reply side rather than inventing a new one.
   * Undefined/null everywhere else.
   */
  triggeringMessageId?: string | null
  /**
   * Unique id for this top-level cayeAgent()/runToolLoop invocation —
   * one per inbound WhatsApp message (or briefing/EOD cron run). Load-
   * bearing for the high-risk confirmation gate: a staged action can
   * only execute when confirmed from a DIFFERENT requestId than the one
   * that staged it, which structurally forces a real human turn (a new
   * inbound message) between staging and execution — see
   * lib/caye-agent/tools/high-risk-gate.ts.
   */
  requestId: string
  /**
   * Marks this invocation as a system-generated periodic scan (the
   * opportunity-scan and business-insights crons) rather than a real
   * inbound message. Undefined everywhere else — fully backward
   * compatible. business-insights is read-only by design and shouldn't
   * ever call a gated tool, but it's tagged 'scan' anyway as defense in
   * depth: cheap, and it means NO periodic system-generated caller can
   * ever be mistaken for a human confirming a staged action.
   *
   * Load-bearing for gateHighRisk: requestId alone can't distinguish "a
   * human sent a new message" from "the scan ran again," since both
   * produce a fresh requestId. Two independent scan runs could otherwise
   * each stage the same tool+args and the second would read as
   * confirming the first, auto-executing a high-risk action with zero
   * human involved. gateHighRisk refuses to treat origin: 'scan' as a
   * confirming call — a scan can stage a proposal but only a real
   * chat-origin invocation can confirm it.
   */
  origin?: 'chat' | 'scan'
  /**
   * Deterministic key for this exact (turn, tool, arguments) triple, set by
   * runToolWithRecovery before execute() is called (2026-08-11).
   *
   * Tools with external side effects thread this into the system they call
   * so a retry — by the orchestrator, or by the model repeating itself
   * within a turn — collapses onto the same operation instead of creating a
   * second booking / event / charge. Optional because most tools write only
   * to Supabase behind a uniqueness constraint and don't need it.
   */
  operationKey?: string
  /**
   * Accumulator for relate_to_direct_thread (2026-08-13, back-office only).
   * Tools that decide the current exchange belongs to a Caye Direct thread
   * push the thread id here rather than linking a message directly —
   * mid-loop, the turns that will end up in caye_operator_messages don't
   * have row ids yet (persistAgentTurns runs after the loop, in the
   * caller). index.ts initializes this to [] before invoking runToolLoop
   * and reads it back afterward so the caller (webhook / Direct route) can
   * link every newly-inserted turn to each requested thread once real ids
   * exist. Optional — every other mode/context leaves it undefined and
   * relate_to_direct_thread simply isn't registered there.
   */
  directThreadLinks?: string[]
  /**
   * Accumulator for front-desk read tools (2026-08-16, Phase 3). Each
   * front-desk read tool that establishes a fact deterministically (a
   * real price from the pricing tables, real availability rules actually
   * evaluated, a real customer/booking match) pushes the corresponding
   * `EvidenceFact` here on success. `send_customer_reply`
   * (write-high/send-customer-reply.ts) reads this back at the end of
   * the same tool loop to decide, via the existing evidence/disposition
   * policy (evidence.ts) that already governs `lib/caye-reply.ts`'s
   * production sends, whether a drafted reply may go out autonomously or
   * must be held for a human. Same accumulator shape as
   * `directThreadLinks` above — a mutable array a specific set of tools
   * write into and a specific later tool reads, not a general framework.
   * Optional and undefined everywhere else (back-office/driver/admin-shell
   * tools never read or write it).
   */
  evidenceCollected?: EvidenceFact[]
  /**
   * Stable id for one logical multi-step investigation (2026-08-17 Bimini
   * revenue-audit incident). Unlike `requestId` (fresh per runToolLoop
   * invocation — one per inbound message), this stays the SAME across the
   * internal continuation turns lib/caye-agent/investigation.ts drives when
   * a founder-authorized investigation runs long enough to exceed
   * MAX_TOOL_ITERATIONS in one call. Threaded into caye_tool_calls so every
   * tool call made anywhere in the investigation can be found by this one
   * key, independent of which runToolLoop call or which (possibly
   * compacted) conversation turn it happened in. Undefined for ordinary
   * turns — nothing about a normal single-shot tool call changes.
   */
  investigationId?: string | null
  /**
   * The workspace's IANA timezone (customers.timezone), e.g.
   * "America/Nassau" (2026-08-18, CAY-91). Read tools that classify a
   * booking as past/today/tomorrow/upcoming — or compute "today" at all —
   * must resolve it in THIS timezone via lib/booking-time.ts, never in UTC
   * or by asking the model to do the arithmetic. Set once in index.ts from
   * the same `customers` row already fetched for the back-office prompt so
   * every tool call in the turn shares one resolved value. Undefined for
   * modes with no workspace timezone concept (driver, admin-shell); tools
   * that read it fall back to 'America/Nassau' (the same sane default
   * caye-reply.ts already uses) rather than silently reasoning in UTC.
   */
  workspaceTimezone?: string | null
}

/**
 * Structured tool output. Stringified and handed back to Claude in a
 * tool_result block.
 *
 * Defined in ./result alongside the outcome taxonomy and its constructors,
 * and re-exported here so the ~60 tools that already `import type
 * { ToolResult } from '../types'` keep compiling untouched. `ok`/`data`/
 * `error` mean exactly what they always did; `status` and friends are
 * additive and optional.
 */
export type { ToolResult, ToolStatus } from './result'

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
  /**
   * PHASE 3B (2026-08-16). When true AND this tool's execute() returns
   * `ok: true`, runToolLoop ends the turn immediately after this round
   * instead of looping back to the model for another round. Exists for
   * front-desk's `send_customer_reply`: once a reply has actually been
   * delivered to the customer, there is nothing left to decide — but
   * front-desk also forces `tool_choice: 'any'` on every round (see
   * runToolLoop), so without an explicit stopping signal the model would
   * be forced to call ANOTHER tool immediately after a successful send,
   * with nothing left to do, burning iterations until the loop's own
   * degrade fallback kicks in. Mirrors caye-reply.ts's `terminal` return
   * pattern (`if (terminal) return terminal` in generateCayeAutoReply) —
   * that runtime already solved this by treating certain tool calls as
   * ending the turn at the code level rather than the model's. Undefined
   * (falsy) everywhere else — back-office has no such tool and doesn't
   * force `tool_choice`, so this never applies there.
   */
  terminatesTurn?: boolean
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
