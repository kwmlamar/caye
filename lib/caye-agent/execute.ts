import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { TOOL_REGISTRY } from './tools/registry'
import { asAnthropicTool, type Role, type Tool, type ToolContext, type ToolMode } from './tools/types'
import { stripForModel } from './tools/result'
import { runToolWithRecovery, guidanceFor } from './orchestrator'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { decideDisposition, type EvidenceSet } from './evidence'
import { extractDollarAmounts, assertsAvailability } from './draft-claims'
import { detectIdentityLeak } from '@/lib/caye-identity-guard'
import { detectUnverifiedPaymentFigure, detectUnverifiedPaymentMethodClaim } from '@/lib/policy-figure-guard'
import { unsupportedLogisticsTimeClaims } from './logistics-grounding'
import { fetchAuthoritativeThread } from './fetch-authoritative-thread'
import { fetchBusinessFacts } from '@/lib/business-facts'
import { createServiceClient } from '@/lib/supabase-server'
import { enforceActionGrounding, type ExecutedToolOutcome } from './action-claim-guard'
import { detectToolNameLeak } from '@/lib/operator-text-guard'

// Safety: bound the tool loop so a misbehaving model can't call tools
// forever. 5 iterations is generous — most operator asks resolve in 1-2.
const MAX_TOOL_ITERATIONS = 5

export interface ToolLoopArgs {
  client: Anthropic
  model: string
  maxTokens: number
  systemPrompt: string
  initialMessages: Anthropic.MessageParam[]
  ctx: ToolContext
  /**
   * Caye surface this call is on (#56). Filters TOOL_REGISTRY to tools
   * whose modes[] includes this value before the schemas are shipped to
   * Claude. Defaults to 'back-office' since every existing call site is
   * back-office; pass 'front-desk' when caye-reply.ts migrates onto this
   * runner (separate work, #14).
   */
  mode?: ToolMode
  /**
   * PHASE 1 of runtime convergence (2026-08-16). Optional override of the
   * tool set this loop runs against. Every live call site omits this and
   * gets today's exact behavior — TOOL_REGISTRY filtered by `mode`, looked
   * up by name from that same registry. It exists solely for the
   * historical replay harness (`lib/caye-agent/replay/*`), which needs
   * this loop's real mechanics (system/tool caching, the tool-use round
   * trip, error shaping) to run against dry-run-wrapped tools
   * (`lib/caye-agent/tools/dry-run.ts`) so a replayed turn can never reach
   * a real side effect. When provided, THIS list — not TOOL_REGISTRY — is
   * both what's shipped to the model and what a tool-name lookup resolves
   * against below, so a wrapped tool's interception can't be silently
   * bypassed by falling back to the real registry entry of the same name.
   */
  tools?: Tool<never>[]
  /**
   * Structural write-exclusion (2026-08-17 Bimini revenue-audit fix). When
   * true, the tool list shipped to Claude is filtered down to `risk: 'read'`
   * tools only — used by investigation continuation passes
   * (lib/caye-agent/investigation.ts) so a resumed multi-round investigation
   * can keep reading but can never write on a pass the founder didn't
   * directly see and respond to. Undefined/false on every ordinary turn,
   * where the full mode-scoped registry (or `tools` override) applies as
   * before.
   */
  readOnly?: boolean
}

export interface ToolLoopResult {
  /** The final user-facing text reply (joined text blocks of the last assistant turn). */
  replyText: string
  /**
   * All turns produced during the loop, in order. Caller persists each
   * to `caye_operator_messages.claude_format` so the sliding window
   * sees them on the next inbound message.
   */
  newTurns: Anthropic.MessageParam[]
  /**
   * PHASE 3B. True only when a front-desk turn ended with zero tool_use
   * blocks DESPITE `tool_choice: { type: 'any' }` being sent — i.e. the
   * defense-in-depth branch ran, not the normal `send_customer_reply`
   * path. Observed live during Phase 3B verification (not just a
   * theoretical edge case): the Anthropic API does not treat `any` as
   * fully airtight against every model response. Exists so a caller
   * (replay harness today; a future real webhook) can log/alert on the
   * rate this happens at, independent of whether the resulting text
   * passed or was held. Undefined on every non-front-desk call and on
   * every front-desk call that went through a tool normally.
   */
  usedOutputFallbackPath?: boolean
  /**
   * True only when the loop exhausted MAX_TOOL_ITERATIONS without Claude
   * producing a text-only turn (2026-08-17 Bimini revenue-audit fix). The
   * caller (lib/caye-agent/founder-thread-turn.ts) uses this to resume the
   * investigation as a fresh continuation pass instead of surfacing the
   * generic degrade message below as a final answer. Undefined/false on
   * every turn that finished normally.
   */
  ranOutOfIterations?: boolean
}

export interface ToolSurfaceMetrics {
  mode: ToolMode
  callerRole: Role
  exposedToolCount: number
  excludedByRoleCount: number
  excludedByReadOnlyCount: number
  exposedToolSchemaBytes: number
  excludedToolSchemaBytes: number
  /** Custom/replay registries preserve their caller-supplied surface exactly. */
  usesCustomTools: boolean
}

/**
 * Deterministically selects only tools this caller could execute. This is a
 * prompt-surface optimization, not an authorization mechanism: the runtime
 * role gate below remains authoritative, including for custom replay tools.
 */
export function selectToolSurface(args: Pick<ToolLoopArgs, 'tools' | 'mode' | 'readOnly' | 'ctx'>): {
  tools: Tool<never>[]
  metrics: ToolSurfaceMetrics
} {
  const mode: ToolMode = args.mode ?? 'back-office'
  const usesCustomTools = Boolean(args.tools)
  const modeScoped = args.tools ?? TOOL_REGISTRY.filter((tool) => tool.modes.includes(mode))
  const roleEligible = usesCustomTools
    ? modeScoped
    : modeScoped.filter((tool) => tool.roles.includes(args.ctx.callerRole))
  const selected = roleEligible.filter((tool) => !args.readOnly || tool.risk === 'read')
  const excludedByRole = modeScoped.filter((tool) => !roleEligible.includes(tool))
  const excludedByReadOnly = roleEligible.filter((tool) => !selected.includes(tool))
  const schemaBytes = (tools: readonly Tool<never>[]) =>
    tools.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(tools.map(asAnthropicTool)), 'utf8')

  return {
    tools: selected,
    metrics: {
      mode,
      callerRole: args.ctx.callerRole,
      exposedToolCount: selected.length,
      excludedByRoleCount: excludedByRole.length,
      excludedByReadOnlyCount: excludedByReadOnly.length,
      exposedToolSchemaBytes: schemaBytes(selected),
      excludedToolSchemaBytes: schemaBytes([...excludedByRole, ...excludedByReadOnly]),
      usesCustomTools,
    },
  }
}

/**
 * Run a Claude tool-use loop against the registered back-office tools.
 *
 * Loop semantics:
 *   1. Send messages to Claude with the tool list.
 *   2. If Claude responds with tool_use blocks, execute each tool, build
 *      a user turn of tool_result blocks, push, and continue.
 *   3. If Claude responds with text only (no tool_use), we're done.
 *
 * Risk gating: read/low-risk tools execute immediately. High-risk tools
 * are wrapped in registry.ts with gateHighRisk (#64), which stages the
 * first call and only executes on a confirming call from a later,
 * separate request — see lib/caye-agent/tools/high-risk-gate.ts. That
 * gate is structural, not prompt-based: it holds even if the model tries
 * to call a high-risk tool without the operator having agreed to anything.
 */
export async function runToolLoop(args: ToolLoopArgs): Promise<ToolLoopResult> {
  // Cache breakpoint on the last tool caches the entire tools array.
  // The back-office system prompt is workspace-stable (operator profile
  // and voice profile only change on owner edits), so the system block
  // is cached at 1h TTL alongside the tools. Locked 2026-06-24 (#46) —
  // previously this path shipped zero caching (raw string system, no
  // tool cache_control), giving ~0% cache reads on the back-office surface.
  const { tools: toolRegistry, metrics: toolSurface } = selectToolSurface(args)
  const mode = toolSurface.mode
  // Structured metadata only. This is intentionally emitted once per
  // top-level loop, not per model turn, so it can measure surface changes
  // without storing prompts, customer content, or tool arguments.
  console.info('[caye-agent/execute] tool surface', toolSurface)
  const tools = toolRegistry.map(asAnthropicTool)
  if (tools.length > 0) {
    const last = tools[tools.length - 1]
    tools[tools.length - 1] = {
      ...last,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    } as Anthropic.Tool
  }
  const messages: Anthropic.MessageParam[] = [...args.initialMessages]
  const newTurns: Anthropic.MessageParam[] = []
  // Every tool outcome across the whole loop (not just the current round),
  // so the action-grounding guard below can tell a real completed action
  // from one the model only intended. See action-claim-guard.ts.
  const executedTools: ExecutedToolOutcome[] = []
  const applyActionGrounding = (text: string): string => {
    const { text: grounded, violations } = enforceActionGrounding(text, executedTools)
    if (violations.length > 0) {
      console.error(
        `[caye-agent/execute] stripped ungrounded completion claim(s) — workspace=${args.ctx.workspaceId} categories=${violations.map((v) => v.category).join(',')}`
      )
    }
    return grounded
  }
  // Backstop for a model naming its own tools out loud (2026-08-17 Pam Ott
  // incident — "should I stage it as a send_reply?"). The prompt already
  // says never to do this; this is the code-level net under that, same
  // shape as applyActionGrounding above. Checked against the tools this
  // turn's registry actually contains, so it can never drift from what's
  // really callable. On a hit, the whole reply is swapped for a clean
  // generic line rather than trying to surgically edit around the leaked
  // token — same reaction this codebase already uses for every other
  // internal-leak catch (operator-brief.ts, outbound-worker/route.ts).
  const applyToolNameLeakGuard = (text: string): string => {
    const leaked = detectToolNameLeak(text, toolRegistry.map((t) => t.name))
    if (!leaked) return text
    console.error(
      `[caye-agent/execute] reply named an internal tool ("${leaked}") — workspace=${args.ctx.workspaceId} — falling back`
    )
    return 'I could not safely complete that request in this turn. No operational action was taken.'
  }

  // PHASE 3B — structural final-output safety for front-desk (2026-08-16).
  // `lib/caye-reply.ts`'s live production loop passes this SAME
  // `tool_choice: { type: 'any' }` on every round (see its call to
  // `client.messages.create` in `generateCayeAutoReply`) — it is not new
  // policy, it's this loop catching up to a guarantee production already
  // has. With no tool_choice set (the previous behavior here), the model
  // can end a front-desk turn with a plain text-only response that never
  // passes through `send_customer_reply`'s evidence/disposition gate —
  // the exact gap Phase 3 found live in the Christina/accessibility replay
  // (a fully-grounded, correct answer that happened to bypass the gate
  // by construction, not by the model doing anything wrong). Forcing
  // `any` here means every front-desk round MUST include a tool call, so
  // the only way text ever reaches a customer is through
  // `send_customer_reply`'s execute() — there is no second, ungated path.
  // Deliberately mode-scoped: back-office's replyText goes to the
  // OPERATOR, not a customer, and every customer-facing back-office
  // action already routes through an explicit gated tool regardless of
  // what free text the operator-facing turn ends on — forcing `any` there
  // would only make Caye's operator-facing chat needlessly stilted.
  const forceToolUse = mode === 'front-desk' && tools.length > 0

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await loggedMessagesCreate(args.client, {
      model: args.model,
      max_tokens: args.maxTokens,
      system: [
        {
          type: 'text',
          text: args.systemPrompt,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages,
      tools,
      ...(forceToolUse ? { tool_choice: { type: 'any' as const } } : {}),
    }, { source: 'lib/caye-agent/execute.ts:runToolLoop', workspaceId: args.ctx.workspaceId })

    const assistantTurn: Anthropic.MessageParam = {
      role: 'assistant',
      content: response.content,
    }
    messages.push(assistantTurn)
    newTurns.push(assistantTurn)

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )

    if (toolUseBlocks.length === 0) {
      // Claude is done. Pull text out of the final turn.
      const rawReplyText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()

      // Action-grounding backstop (2026-08-16) — see action-claim-guard.ts.
      // Runs before every other check below so a stripped/corrected claim,
      // not the model's raw prose, is what identity/payment/evidence
      // guards and the final return see. Tool-name-leak guard runs after —
      // order doesn't matter between the two (disjoint failure shapes), but
      // this keeps the freshest text going into the last check.
      const replyText = applyToolNameLeakGuard(applyActionGrounding(rawReplyText))

      // The turn just pushed onto `newTurns`/`messages` above still holds
      // the model's RAW content — persistAgentTurns writes that straight
      // into caye_operator_messages.body/claude_format (and it's what the
      // next turn's sliding-window history replays back to the model), so
      // a correction that only changed the returned `replyText` would
      // never reach the founder's actual Caye Direct transcript. Patch the
      // turn itself so the persisted record and the returned text agree.
      if (replyText !== rawReplyText) {
        const lastTurn = newTurns[newTurns.length - 1]
        if (lastTurn?.role === 'assistant') {
          lastTurn.content = [{ type: 'text', text: replyText }]
        }
      }

      // PHASE 3B / final pre-canary closure — defense in depth.
      // `tool_choice: { type: 'any' }` above should make this branch
      // unreachable on front-desk turns; observed live during
      // verification that it is NOT fully airtight, so this text has
      // sometimes never passed through `send_customer_reply`'s guards at
      // all. Runs the FULL SAME guard suite that tool applies — identity
      // leak, payment figure, payment method, evidence/disposition
      // (price+availability), and — when `ctx.conversationId` is known —
      // logistics-time grounding too. Every check here is the exact same
      // canonical function `send_customer_reply` calls; nothing here is a
      // second approximation. A held result never becomes `replyText`;
      // nothing here decides to send anything, it only decides whether
      // unvalidated text is allowed to leave the loop.
      if (forceToolUse) {
        const fallbackHold = (reason: string): ToolLoopResult => {
          console.error(
            `[caye-agent/execute] front-desk turn ended without a tool call and failed the output-safety check (${reason}) — refusing to surface it. workspace=${args.ctx.workspaceId}`
          )
          return {
            replyText: 'I need a team member to verify a detail before I can answer that.',
            newTurns,
            usedOutputFallbackPath: true,
          }
        }

        const identityLeak = detectIdentityLeak(replyText)
        if (identityLeak) return fallbackHold(`identity leak: ${identityLeak}`)

        const supabase = createServiceClient()
        const [businessFacts, businessSentThread] = await Promise.all([
          fetchBusinessFacts(args.ctx.workspaceId),
          // Same parity reasoning as send_customer_reply's own grounding
          // (see fetchAuthoritativeThread's doc comment): only available
          // when ctx.conversationId is set, same disclosed gap as the
          // logistics check below when it's absent.
          args.ctx.conversationId
            ? fetchAuthoritativeThread(supabase, args.ctx.conversationId, 'business')
            : Promise.resolve(''),
        ])
        const factsGrounding = [businessFacts.map((f) => f.fact).join('\n'), businessSentThread]
          .filter(Boolean)
          .join('\n')

        const paymentFigure = detectUnverifiedPaymentFigure(replyText, factsGrounding)
        if (paymentFigure) return fallbackHold(`payment figure: ${paymentFigure}`)

        const paymentMethod = detectUnverifiedPaymentMethodClaim(replyText, factsGrounding)
        if (paymentMethod) return fallbackHold(`payment method: ${paymentMethod}`)

        // Logistics-time grounding needs the real thread, which needs a
        // known conversation — only available when the caller (a real
        // front-desk invocation) set ctx.conversationId. Skipped, not
        // approximated, when absent; see ToolContext.conversationId's doc
        // comment for why this is a data-availability gap, not a design one.
        if (args.ctx.conversationId) {
          const authoritativeThread = await fetchAuthoritativeThread(supabase, args.ctx.conversationId)
          const unsupportedLogistics = unsupportedLogisticsTimeClaims(replyText, authoritativeThread)
          if (unsupportedLogistics.length > 0) {
            return fallbackHold(`ungrounded logistics time: ${unsupportedLogistics.join(', ')}`)
          }
        }

        const evidence: EvidenceSet = new Set(args.ctx.evidenceCollected ?? [])
        const quotesPrice = extractDollarAmounts(replyText).length > 0
        const claimsAvailability = assertsAvailability(replyText)
        const disposition = decideDisposition({ evidence, quotesPrice, claimsAvailability })
        if (disposition.disposition === 'hold') {
          return fallbackHold(`evidence: ${disposition.reasons.join(', ')}`)
        }

        console.warn(
          `[caye-agent/execute] front-desk turn ended without a tool call despite tool_choice:'any' — passed every output-safety check, so it was allowed through, but this call never routed through send_customer_reply. workspace=${args.ctx.workspaceId}`
        )
        return { replyText, newTurns, usedOutputFallbackPath: true }
      }

      return { replyText, newTurns }
    }

    // Execute each tool, append tool_result blocks as a single user turn.
    // PHASE 3B: also track whether any call this round was a successful
    // terminatesTurn tool — see Tool.terminatesTurn's doc comment for why
    // this exists (forceToolUse would otherwise force a pointless extra
    // tool call after a reply has already been delivered).
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let terminalReplyText: string | null = null
    for (const block of toolUseBlocks) {
      const tool = toolRegistry.find((t) => t.name === block.name)
      if (!tool) {
        executedTools.push({ name: block.name, ok: false })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ok: false,
            error: `Unknown tool: ${block.name}`,
          }),
          is_error: true,
        })
        continue
      }
      // Role gate (#48). Reject before execute so a misconfigured tool
      // can't accidentally run for a caller it doesn't permit. Returns a
      // structured error in the tool_result so the model can react in
      // its reply (apologize, escalate) rather than silently failing.
      if (!tool.roles.includes(args.ctx.callerRole)) {
        executedTools.push({ name: block.name, ok: false })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            ok: false,
            error:
              `Tool '${block.name}' is not available to role '${args.ctx.callerRole}'. ` +
              `Permitted roles: ${tool.roles.join(', ')}.`,
          }),
          is_error: true,
        })
        continue
      }
      // Execution, classification, retry, and logging all live in the
      // orchestrator (2026-08-11) — runToolWithRecovery never throws, so
      // there is no catch here any more. What reaches the model is a
      // classified outcome plus an instruction for how to report it, not a
      // raw error string it has to interpret for itself.
      const { result } = await runToolWithRecovery(tool, block.input, args.ctx, { mode, toolUseId: block.id })
      const payload = stripForModel(result)
      const guidance = guidanceFor(result.status, result.deferred === true, block.name, result.error_code)
      if (guidance) payload.how_to_report_this = guidance
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(payload),
        // A deferred write is a success from the operator's side — flagging
        // it as an error is what invites the apologetic "it didn't work"
        // framing this whole path exists to prevent.
        is_error: !result.ok,
      })
      // Action-grounding bookkeeping (action-claim-guard.ts). A gateHighRisk
      // stage is `ok: true` with `data.executed === false` — that must NOT
      // ground a completion claim, only an "awaiting confirmation" one.
      const resultData = result.data as Record<string, unknown> | undefined
      const pendingOnly = result.ok && !!resultData && resultData.executed === false
      executedTools.push({ name: block.name, ok: result.ok, pendingOnly })
      // confirm_pending_action's result is tagged with which underlying
      // tool it ran (confirm-pending-action.ts) — surface that as its own
      // entry so a confirmed send_reply grounds a "sent" claim exactly like
      // a direct send_reply call would.
      const confirmedToolName = resultData?.confirmed_tool_name
      if (typeof confirmedToolName === 'string') {
        executedTools.push({ name: confirmedToolName, ok: result.ok, pendingOnly: false })
      }
      // retrieve_artifact_for_operator's transport is channel-decided, not
      // model-decided (see that tool's own doc comment): `delivery` is
      // 'whatsapp' for a real external send, 'inline' when the artifact
      // just rendered in Caye Direct and nothing was sent anywhere. A
      // "sent"/"messaged" claim must only be grounded by the former — see
      // the distinct groundedBy entry in action-claim-guard.ts. Recorded
      // under a delivery-qualified name (never the bare tool name) so an
      // inline-only turn can never accidentally ground a send claim just
      // because the tool ran successfully.
      if (block.name === 'retrieve_artifact_for_operator' && result.ok && resultData?.delivery === 'whatsapp') {
        executedTools.push({ name: 'retrieve_artifact_for_operator:whatsapp', ok: true, pendingOnly: false })
      }
      if (tool.terminatesTurn && result.ok && terminalReplyText === null) {
        const data = result.data as { delivered_text?: unknown } | undefined
        terminalReplyText = typeof data?.delivered_text === 'string' ? data.delivered_text : ''
      }
    }

    const toolResultTurn: Anthropic.MessageParam = {
      role: 'user',
      content: toolResults,
    }
    messages.push(toolResultTurn)
    newTurns.push(toolResultTurn)

    if (terminalReplyText !== null) {
      return { replyText: terminalReplyText, newTurns }
    }
  }

  // Degrade instead of throwing — a thrown error here previously left the
  // operator with silence (the webhook's catch only logs, see
  // app/api/webhooks/whatsapp-operator/route.ts). Losing the in-progress
  // tool calls is fine; going dark on a paying customer's operator is not.
  console.error(
    `[caye-agent/execute] tool loop exceeded ${MAX_TOOL_ITERATIONS} iterations for workspace ${args.ctx.workspaceId}`
  )
  return {
    replyText: 'I could not complete that request within this turn. No unfinished operation is running in the background.',
    newTurns,
    ranOutOfIterations: true,
  }
}
