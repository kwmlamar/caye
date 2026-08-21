import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { TOOL_REGISTRY } from '@/lib/caye-agent/tools/registry'
import type { Tool, ToolContext } from '@/lib/caye-agent/tools/types'
import { runToolWithRecovery, guidanceFor } from '@/lib/caye-agent/orchestrator'
import { stripForModel } from '@/lib/caye-agent/tools/result'
import { enforceActionGrounding, type ExecutedToolOutcome } from '@/lib/caye-agent/action-claim-guard'
import { detectToolNameLeak } from '@/lib/operator-text-guard'
import { assertFounderRouterAccess } from '../founder-gate'
import { DEFAULT_ROUTER_POLICY, type RouterPolicy } from '../router'
import type { BackendId, FounderRouterContext, RequestedMode, RouterDecision, RouterTaskHints } from '../types'
import type { ToolCapableBackend, ToolTurnResult } from './types'
import { runToolTurnWithFallback } from './tool-turn-router'
import { validateAgainstSchema } from './schema-validate'
import { detectProtocolArtifacts } from './protocol-artifact-guard'
import { requiresBusinessGrounding } from './business-grounding-classifier'

/**
 * Option B from the multi-model router brief: a NEW founder-only
 * orchestration loop, not an extension of lib/caye-agent/execute.ts's
 * runToolLoop(). Why not extend runToolLoop directly (Option A): that
 * function is the live production path for WhatsApp operator traffic AND
 * the converged Zoho front-desk runtime (real customer traffic, shipped
 * 2026-08-16 per commit 6d5cd8c) — adding a pluggable model-call seam
 * there, even an optional one defaulting to today's exact behavior, turns
 * "no customer/background workload can reach my subscription" from a
 * structural guarantee into a discipline one (nobody passes the param on
 * that path). This file is reachable from nowhere a webhook/cron imports,
 * gated by assertFounderRouterAccess as its only entry point — structural,
 * not disciplined.
 *
 * What IS reused, unchanged, imported directly: TOOL_REGISTRY,
 * runToolWithRecovery (retries, risk-tier budgets, operationKey,
 * caye_tool_calls logging), enforceActionGrounding, stripForModel,
 * guidanceFor, the role gate. Nothing tool-related is reimplemented — only
 * "get the next assistant content" is abstracted per backend (see
 * tool-bridge/types.ts's ToolCapableBackend), because that's the one step
 * that is inherently provider-specific. Everything below this loop's
 * model-call line mirrors runToolLoop's control flow closely on purpose:
 * same job, same primitives, one different seam.
 *
 * CORE INVARIANT #1 (added 2026-08-16 after a real, reproducible failure —
 * see fixtures/fabricated-tool-transcripts.ts and
 * protocol-artifact-guard.ts): MODEL TEXT IS NEVER EVIDENCE THAT A TOOL
 * RAN. A tool execution exists only if this loop itself accepted a
 * structured request, resolved it against the restricted TOOL_REGISTRY
 * manifest, schema-validated it, executed it through
 * runToolWithRecovery, and received the real result. resolveRoundResult()
 * is where that's enforced.
 *
 * CORE INVARIANT #2 (added 2026-08-17 after real Claude runs surfaced a
 * SECOND, more serious failure: asked a plain business question, the
 * model sometimes answered directly with fully invented facts — zero tool
 * calls, zero protocol artifacts, nothing for invariant #1's text-shape
 * guard to catch, because it never tried to fake the protocol, it just
 * answered): A FINAL TEXT ANSWER TO A REQUEST CLASSIFIED AS REQUIRING
 * BUSINESS GROUNDING IS NEVER ACCEPTED UNTIL AT LEAST ONE REAL TOOL HAS
 * EXECUTED THIS TURN. This is the founder-mode equivalent of
 * lib/caye-agent/execute.ts's `tool_choice: { type: 'any' }` for
 * front-desk mode — same guarantee (a plain-text reply can never be the
 * FIRST and only thing that happens), reproduced with a state-machine
 * check instead of an API parameter, because none of these backends
 * (subscription CLIs, prose/schema protocols) expose a real tool_choice
 * knob the way the native Anthropic Messages API does. See
 * requiresBusinessGrounding()'s doc comment for why the classifier is
 * deliberately fail-closed rather than trying to enumerate every shape of
 * "needs data."
 */
const MAX_TOOL_ITERATIONS = 5
const DEGRADE_MESSAGE = "Sorry, that one's taking longer than it should — give me a moment and try again."
const UNGROUNDED_DEGRADE_MESSAGE =
  "I wasn't able to verify this against real data, so I'm not going to guess. Try again, or tell me specifically what to look up."

const PROTOCOL_CORRECTION_MESSAGE =
  'Your previous response did not follow the tool protocol: it contained text resembling a simulated tool call and/or a simulated tool result, but no tool actually ran this round — nothing you wrote as a tool call or a tool result was real. ' +
  'Respond now with EXACTLY ONE of: (1) a single fenced ```json``` block containing {"tool_calls":[...]} and nothing else, to request one real tool call, or (2) plain natural-language final text with no simulated tool calls, tool results, or protocol syntax of any kind, based only on information you have actually been given. ' +
  'Never write your own tool result. Never predict what a tool will return. If you still need information, request exactly one real tool now — you will receive its real result in a later turn.'

/**
 * Fed back (invariant #2) when the model answered in plain text before any
 * real tool executed this turn, for a request classified as requiring
 * business grounding. Distinct from PROTOCOL_CORRECTION_MESSAGE — this
 * isn't about fabricated protocol syntax, it's about skipping the tool
 * step entirely. Never persisted into `newTurns`, same as the protocol
 * correction — see runFounderToolLoop's handling.
 */
const GROUNDING_REQUIRED_MESSAGE =
  'This request needs to be answered from real Caye data, not from memory or general knowledge — you have not called any tool yet this turn. ' +
  'Request one of the available tools now with a real tool_calls request. Do not answer in plain text until you have a real result from Caye.'

/**
 * Thrown when a subscription backend returns a fabricated/simulated tool
 * transcript as final text, and the one allowed same-backend retry
 * (brief section 7) either also fails the protocol-artifact guard or the
 * backend itself has become unavailable to retry against. Neither attempt
 * is ever returned as an answer — see resolveRoundResult().
 */
export class ProtocolViolationError extends Error {
  constructor(public readonly reasons: readonly string[], public readonly afterRetry: boolean) {
    super(
      afterRetry
        ? `Subscription backend returned a fabricated/simulated tool transcript twice, including after one correction attempt — refusing to return either as an answer. Reasons: ${reasons.join('; ')}`
        : `Subscription backend returned a fabricated/simulated tool transcript and could not be retried. Reasons: ${reasons.join('; ')}`
    )
    this.name = 'ProtocolViolationError'
  }
}

export interface FounderToolLoopArgs {
  ctx: FounderRouterContext
  requestedMode: RequestedMode
  backends: readonly ToolCapableBackend[]
  policy?: RouterPolicy
  toolCtx: ToolContext
  system: string
  initialMessages: Anthropic.MessageParam[]
  maxOutputTokens?: number
  hints?: RouterTaskHints
  signal: AbortSignal
  /**
   * Optional allowlist restricting the exposed tool manifest to these
   * names (still resolved from the real TOOL_REGISTRY — never a
   * substitute/fake registry). Undefined (the default, every live call
   * site) exposes the full mode-filtered registry exactly as before —
   * this is purely additive. Mirrors the same pattern
   * lib/caye-agent/execute.ts's ToolLoopArgs.tools override already
   * established for its replay harness: a real, needed override, not a
   * parallel runtime. Added for the 2026-08-16 controlled real-tool proof
   * (structural tool restriction, not a prompt-only instruction) and now
   * available to any future caller that needs the same guarantee.
   */
  restrictToToolNames?: readonly string[]
}

export interface FounderToolLoopResult {
  replyText: string
  newTurns: Anthropic.MessageParam[]
  linkedThreadIds: string[]
  decision: RouterDecision
}

function isToolUseBlock(b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock {
  return b.type === 'tool_use'
}

function joinTextBlocks(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** Text of the most recent user turn — what the founder actually just asked, for the grounding classifier. */
function extractLatestUserText(messages: readonly Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    return m.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * Resolves one round's raw backend output into content this loop may
 * safely act on. A real structured tool request passes through untouched
 * (nothing to guard — it either resolves against the real registry or
 * gets rejected downstream exactly as before). Text is checked against
 * protocol-artifact-guard.ts before it is ever trusted; a violation gets
 * exactly one same-backend retry (brief section 7) with a correction
 * message that is never persisted into the real conversation, win or
 * lose. Throws ProtocolViolationError rather than ever returning
 * fabricated content.
 */
async function resolveRoundResult(params: {
  result: ToolTurnResult
  backend: ToolCapableBackend | undefined
  baseMessages: readonly Anthropic.MessageParam[]
  system: string
  tools: Tool<never>[]
  maxOutputTokens: number
  ctx: FounderRouterContext
  hints: RouterTaskHints | undefined
  signal: AbortSignal
  workspaceId: string
}): Promise<Anthropic.ContentBlock[]> {
  const { result, backend } = params
  if (result.content.some(isToolUseBlock)) {
    return result.content // real structured request — nothing to guard
  }

  const text = joinTextBlocks(result.content)
  const finding = detectProtocolArtifacts(text)
  if (!finding.violated) {
    return result.content
  }

  console.error(
    `[model-router/founder-tool-loop] protocol-artifact violation detected — workspace=${params.workspaceId} backend=${backend?.id} reasons=${finding.reasons.join(' | ')}`
  )

  if (!backend) {
    throw new ProtocolViolationError(finding.reasons, false)
  }

  // Retry against the SAME backend only — never the fallback chain, per
  // brief section 7. The correction is appended for this one call only;
  // baseMessages (and therefore the real conversation) never sees it.
  const retryMessages: Anthropic.MessageParam[] = [
    ...params.baseMessages,
    { role: 'user', content: PROTOCOL_CORRECTION_MESSAGE },
  ]
  const retryResult = await backend.invokeTurn(
    {
      ctx: params.ctx,
      system: params.system,
      messages: retryMessages,
      tools: params.tools,
      maxOutputTokens: params.maxOutputTokens,
      hints: params.hints,
    },
    params.signal
  )

  if (retryResult.content.some(isToolUseBlock)) {
    return retryResult.content
  }

  const retryText = joinTextBlocks(retryResult.content)
  const retryFinding = detectProtocolArtifacts(retryText)
  if (!retryFinding.violated) {
    return retryResult.content
  }

  console.error(
    `[model-router/founder-tool-loop] protocol-artifact violation persisted after retry — workspace=${params.workspaceId} backend=${backend.id} reasons=${retryFinding.reasons.join(' | ')}`
  )
  throw new ProtocolViolationError([...finding.reasons, ...retryFinding.reasons], true)
}

export async function runFounderToolLoop(args: FounderToolLoopArgs): Promise<FounderToolLoopResult> {
  assertFounderRouterAccess(args.ctx)

  const tools: Tool<never>[] = TOOL_REGISTRY.filter(
    (t) => t.modes.includes('back-office') && (!args.restrictToToolNames || args.restrictToToolNames.includes(t.name))
  )
  const messages: Anthropic.MessageParam[] = [...args.initialMessages]
  const newTurns: Anthropic.MessageParam[] = []
  const executedTools: ExecutedToolOutcome[] = []
  const policy = args.policy ?? DEFAULT_ROUTER_POLICY
  const maxOutputTokens = args.maxOutputTokens ?? 8192

  // Invariant #2's routing decision, computed once from what the founder
  // actually asked — see business-grounding-classifier.ts. Deliberately
  // NOT re-evaluated per round: the underlying request doesn't change
  // across rounds within one turn, only whether it's been grounded yet.
  const requiresGrounding = requiresBusinessGrounding(extractLatestUserText(messages))

  // Invariant #2's provenance flag: true once ANY real tool has executed
  // this turn (ok or error — an error result is still real information,
  // e.g. "no customer found" is grounded, not fabricated). Set only
  // inside the real runToolWithRecovery call below, never inferred from
  // model text.
  let anyRealToolExecutedThisTurn = false

  // Set once a write tool (risk !== 'read') has been ATTEMPTED this turn —
  // attempt, not just success, per the brief: "never fall back to another
  // provider after a side effect MAY HAVE occurred." From that point on,
  // every subsequent round is restricted to exactly the one backend that
  // served the write; if that backend then fails, the loop surfaces the
  // failure rather than silently trying a different provider mid-turn.
  let pinnedChain: BackendId[] | undefined
  let lastDecision: RouterDecision | undefined

  const applyActionGrounding = (text: string): string => {
    const { text: grounded, violations } = enforceActionGrounding(text, executedTools)
    if (violations.length > 0) {
      console.error(
        `[model-router/founder-tool-loop] stripped ungrounded completion claim(s) — workspace=${args.toolCtx.workspaceId} categories=${violations.map((v) => v.category).join(',')}`
      )
    }
    return grounded
  }
  // Mirrors execute.ts's identical guard — see lib/operator-text-guard.ts's
  // detectToolNameLeak doc comment for why (2026-08-17 Pam Ott incident).
  // This loop reuses the same real TOOL_REGISTRY-derived `tools` list, so
  // the vocabulary can't drift between the two runners.
  const applyToolNameLeakGuard = (text: string): string => {
    const leaked = detectToolNameLeak(text, tools.map((t) => t.name))
    if (!leaked) return text
    console.error(
      `[model-router/founder-tool-loop] reply named an internal tool ("${leaked}") — workspace=${args.toolCtx.workspaceId} — falling back`
    )
    return "Give me a second — let me get you a cleaner answer on that."
  }

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const { result, decision } = await runToolTurnWithFallback(
      args.backends,
      args.requestedMode,
      { ctx: args.ctx, system: args.system, messages, tools, maxOutputTokens, hints: args.hints },
      args.signal,
      policy,
      pinnedChain
    )
    lastDecision = decision

    // Provenance boundary #1: model text is never evidence a tool ran.
    // This is the only place raw backend output is trusted enough to
    // enter the real conversation — see resolveRoundResult()'s doc comment.
    const content = await resolveRoundResult({
      result,
      backend: args.backends.find((b) => b.id === decision.selected),
      baseMessages: messages,
      system: args.system,
      tools,
      maxOutputTokens,
      ctx: args.ctx,
      hints: args.hints,
      signal: args.signal,
      workspaceId: args.toolCtx.workspaceId,
    })

    const toolUseBlocks = content.filter(isToolUseBlock)

    if (toolUseBlocks.length === 0) {
      // Provenance boundary #2 (invariant #2): a clean-looking plain-text
      // answer is STILL not trustworthy on its own if this request needed
      // grounding and nothing real has been fetched yet this turn. Reject
      // WITHOUT persisting — same non-persistence rule as a protocol
      // violation — and force another round via the normal loop, which
      // may pick a different backend (this is not "the backend behaved
      // badly," it just hasn't done the required work yet, so normal
      // Auto/fallback semantics are fine here, unlike the same-backend-only
      // protocol-violation retry).
      if (requiresGrounding && !anyRealToolExecutedThisTurn) {
        console.error(
          `[model-router/founder-tool-loop] rejected an ungrounded first-answer attempt — workspace=${args.toolCtx.workspaceId} backend=${decision.selected}`
        )
        messages.push({ role: 'user', content: GROUNDING_REQUIRED_MESSAGE })
        continue
      }

      const assistantTurn: Anthropic.MessageParam = { role: 'assistant', content }
      messages.push(assistantTurn)
      newTurns.push(assistantTurn)

      const rawReplyText = joinTextBlocks(content)
      const replyText = applyToolNameLeakGuard(applyActionGrounding(rawReplyText))
      if (replyText !== rawReplyText) {
        const lastTurn = newTurns[newTurns.length - 1]
        if (lastTurn?.role === 'assistant') {
          lastTurn.content = [{ type: 'text', text: replyText }]
        }
      }
      return { replyText, newTurns, linkedThreadIds: dedupeThreadLinks(args.toolCtx), decision }
    }

    const assistantTurn: Anthropic.MessageParam = { role: 'assistant', content }
    messages.push(assistantTurn)
    newTurns.push(assistantTurn)

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let terminalReplyText: string | null = null

    for (const block of toolUseBlocks) {
      const tool = tools.find((t) => t.name === block.name)
      if (!tool) {
        executedTools.push({ name: block.name, ok: false })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ ok: false, error: `Unknown tool: ${block.name}` }),
          is_error: true,
        })
        continue
      }

      if (!tool.roles.includes(args.toolCtx.callerRole)) {
        executedTools.push({ name: block.name, ok: false })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ok: false,
            error: `Tool '${block.name}' is not available to role '${args.toolCtx.callerRole}'. Permitted roles: ${tool.roles.join(', ')}.`,
          }),
          is_error: true,
        })
        continue
      }

      // Untrusted-input gate (brief section: "Treat model output requesting
      // a tool as untrusted input. Validate tool name, schema, arguments,
      // authorization, current state, and risk tier inside Caye before
      // execution.") Native Anthropic tool-use is schema-constrained by the
      // API before Caye ever sees it; a CLI-derived tool call parsed out of
      // text has no such upstream guarantee, so this is the first point
      // ANY backend's tool call is actually checked against the tool's
      // real inputSchema.
      const validation = validateAgainstSchema(tool.inputSchema as Record<string, unknown>, block.input)
      if (!validation.valid) {
        executedTools.push({ name: block.name, ok: false })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ok: false,
            error: `Invalid arguments for tool '${block.name}': ${validation.errors.join('; ')}`,
          }),
          is_error: true,
        })
        continue
      }

      // Pin on ATTEMPT, before execute() runs — see this file's doc comment.
      if (tool.risk !== 'read' && decision.selected) {
        pinnedChain = [decision.selected]
      }

      const { result: toolResult } = await runToolWithRecovery(tool, block.input, args.toolCtx, { mode: 'back-office' })
      anyRealToolExecutedThisTurn = true
      const payload = stripForModel(toolResult)
      const guidance = guidanceFor(toolResult.status, toolResult.deferred === true)
      if (guidance) payload.how_to_report_this = guidance
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(payload),
        is_error: !toolResult.ok,
      })

      const resultData = toolResult.data as Record<string, unknown> | undefined
      const pendingOnly = toolResult.ok && !!resultData && resultData.executed === false
      executedTools.push({ name: block.name, ok: toolResult.ok, pendingOnly })
      const confirmedToolName = resultData?.confirmed_tool_name
      if (typeof confirmedToolName === 'string') {
        executedTools.push({ name: confirmedToolName, ok: toolResult.ok, pendingOnly: false })
      }
      if (tool.terminatesTurn && toolResult.ok && terminalReplyText === null) {
        const data = toolResult.data as { delivered_text?: unknown } | undefined
        terminalReplyText = typeof data?.delivered_text === 'string' ? data.delivered_text : ''
      }
    }

    const toolResultTurn: Anthropic.MessageParam = { role: 'user', content: toolResults }
    messages.push(toolResultTurn)
    newTurns.push(toolResultTurn)

    if (terminalReplyText !== null) {
      return { replyText: terminalReplyText, newTurns, linkedThreadIds: dedupeThreadLinks(args.toolCtx), decision }
    }
  }

  const groundingNeverAchieved = requiresGrounding && !anyRealToolExecutedThisTurn
  console.error(
    `[model-router/founder-tool-loop] tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations for workspace ${args.toolCtx.workspaceId}${groundingNeverAchieved ? ' (grounding required and never achieved)' : ''}`
  )
  return {
    replyText: groundingNeverAchieved ? UNGROUNDED_DEGRADE_MESSAGE : DEGRADE_MESSAGE,
    newTurns,
    linkedThreadIds: dedupeThreadLinks(args.toolCtx),
    decision: lastDecision ?? { requestedMode: args.requestedMode, chain: [], fallbacksTried: [] },
  }
}

function dedupeThreadLinks(toolCtx: ToolContext): string[] {
  return [...new Set(toolCtx.directThreadLinks ?? [])]
}
