import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { TOOL_REGISTRY } from './tools/registry'
import { asAnthropicTool, type Tool, type ToolContext, type ToolMode } from './tools/types'
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
  const mode: ToolMode = args.mode ?? 'back-office'
  // The override registry (replay harness only — see ToolLoopArgs.tools) is
  // used as-is, already scoped by whoever built it. The default path is
  // byte-for-byte what ran before this field existed.
  const toolRegistry: Tool<never>[] = args.tools ?? TOOL_REGISTRY.filter((t) => t.modes.includes(mode))
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
      const replyText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()

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
            replyText: "Let me double check a detail before I get back to you on that — following up shortly.",
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
      const { result } = await runToolWithRecovery(tool, block.input, args.ctx, { mode })
      const payload = stripForModel(result)
      const guidance = guidanceFor(result.status, result.deferred === true)
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
    replyText: "Sorry, that one's taking longer than it should — give me a moment and try again.",
    newTurns,
  }
}
