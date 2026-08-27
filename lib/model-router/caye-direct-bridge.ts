import 'server-only'
import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { buildBackOfficeTurnContext } from '@/lib/caye-agent'
import type { ToolContext } from '@/lib/caye-agent/tools/types'
import { runFounderToolLoop } from './tool-bridge/founder-tool-loop'
import { ClaudeSubscriptionBackend } from './backends/claude-subscription'
import { OpenAICodexSubscriptionBackend } from './backends/openai-codex-subscription'
import { AnthropicApiBackend } from './backends/anthropic-api'
import { OpenAIApiBackend, OpenRouterBackend } from './backends/openai-compatible'
import type { ToolCapableBackend } from './tool-bridge/types'
import type { BackendId, FounderRouterContext, RequestedMode, RouterDecision } from './types'
import { buildInvocationLog } from './observability'
import type { RichResult } from '@/lib/caye-direct-rich-results'

const FOUNDER_DIRECT_REASONING_GUIDANCE = `FOUNDER DIRECT — SYNTHESIZE BEFORE YOU DECLARE SOMETHING UNDEFINED
- The founder is using Caye Direct as an operating/thinking interface, not merely querying configured database objects.
- Treat explicit goals, standing rules, and saved memory as authoritative signals when they exist, but do NOT equate "no formal goal row" with "no priorities" or "nothing to focus on".
- For broad questions such as "what are our current priorities?", "what matters right now?", "what should we focus on?", "how are we doing?", or similar operating-status questions, inspect the current workspace with the available READ tools before answering when the answer is not already pinned authoritatively in context.
- Synthesize the smallest useful ranked view from real evidence: active/upcoming customer commitments, unresolved conversations, bookings, leads/sales state, pending work or approvals, channel/integration gaps, owner-attention items, recent corrections, and explicit workspace goals where present.
- If priorities are inferred rather than owner-defined, say that plainly in one short clause (for example: "No owner-defined priorities are saved, so these are the priorities I infer from current operations.") and then give the inferred priorities. Do not stop at the absence of formal goals and ask the founder to configure them first.
- Never invent a priority merely to fill a list. Ground each inferred item in current workspace evidence; if evidence is genuinely too thin, state what is known and what is missing.
- Operator/global Direction and per-workspace business state are different scopes. Do not leak operator-global goals into a customer workspace unless they are explicitly available in the scoped context.`

/**
 * The ONE call site where a real Caye Direct thread turn can be answered by
 * a founder-authenticated subscription/API model instead of Caye's
 * production execute.ts::runToolLoop. Deliberately thin: all it does is
 * (1) build the exact same system prompt + history buildBackOfficeTurnContext
 * gives the production path, (2) hand it to the founder-only tool loop with
 * the three real backends, (3) shape the result identically to
 * CayeAgentResult so lib/caye-agent/founder-thread-turn.ts's persistence
 * code downstream doesn't need to know or care which path produced it.
 *
 * Callers MUST supply a founderUserId sourced from a verified session
 * (requireFounder()) — never from request-body input. assertFounderRouterAccess
 * (inside runFounderToolLoop) re-checks it against the same allowlist
 * lib/founder.ts's requireFounder used, so a caller cannot bypass the gate
 * by constructing this context wrong; it can only fail closed harder.
 */
export interface CayeDirectRouterTurnArgs {
  workspaceId: string
  threadId: string
  founderUserId: string
  callerName: string | null
  operatorId: number | null
  message: string
  requestedMode: RequestedMode
  /**
   * Test-only escape hatch, same purpose and precedent as
   * FounderToolLoopArgs.restrictToToolNames (see that doc comment) — undefined
   * on every real call site (app/api/founder/caye-direct's route never reads
   * or forwards a field like this from the request body, so an HTTP caller
   * cannot reach it), set only by controlled read-only verification scripts
   * that need a real, DB-persisted Caye Direct turn without exposing write
   * tools to a live subscription model.
   */
  restrictToToolNames?: readonly string[]
}

export interface CayeDirectRouterTurnResult {
  replyText: string
  newTurns: Anthropic.MessageParam[]
  linkedThreadIds: string[]
  backend?: BackendId
  model?: string
  richResult?: RichResult
}

function backendsFor(): ToolCapableBackend[] {
  // Real, registered backends only — no openai_api class exists yet (see
  // capabilities.ts/types.ts's doc comments), so 'openai_api' in a planned
  // chain is silently skipped by runChainWithFallback's byId lookup rather
  // than invented here.
  return [new ClaudeSubscriptionBackend(), new OpenAICodexSubscriptionBackend(), new AnthropicApiBackend(), new OpenAIApiBackend(), new OpenRouterBackend()]
}

export async function runCayeDirectRouterTurn(args: CayeDirectRouterTurnArgs): Promise<CayeDirectRouterTurnResult> {
  const { systemPrompt, initialMessages } = await buildBackOfficeTurnContext({
    mode: 'back-office',
    workspaceId: args.workspaceId,
    userMessage: args.message,
    callerRole: 'founder',
    callerName: args.callerName,
    operatorId: args.operatorId,
    threadId: args.threadId,
  })

  const ctx: FounderRouterContext = {
    founderUserId: args.founderUserId,
    threadId: args.threadId,
    workspaceId: args.workspaceId,
  }

  const directThreadLinks: string[] = []
  const toolCtx: ToolContext = {
    workspaceId: args.workspaceId,
    callerRole: 'founder',
    operatorId: args.operatorId,
    requestId: randomUUID(),
    directThreadLinks,
  }

  // Deliberately no `hints` — see capabilities.ts: setting needsToolUse
  // would filter claude_subscription/openai_codex_subscription out of an
  // Auto chain entirely (their static capability table doesn't claim
  // tool_use, since that table describes NATIVE tool-calling; the real
  // bridging happens structurally inside founder-tool-loop.ts instead).
  // Caye Direct is general business conversation, not a coding/repo task,
  // so isCodingOrRepoTask is correctly left unset too.
  const start = Date.now()
  let decision: RouterDecision | undefined
  try {
    const result = await runFounderToolLoop({
      ctx,
      requestedMode: args.requestedMode,
      backends: backendsFor(),
      toolCtx,
      system: `${systemPrompt}\n\n${FOUNDER_DIRECT_REASONING_GUIDANCE}`,
      initialMessages,
      signal: AbortSignal.timeout(180_000),
      restrictToToolNames: args.restrictToToolNames,
    })
    decision = result.decision

    console.log(
      `[model-router/caye-direct-bridge] turn served — thread=${args.threadId} requestedMode=${args.requestedMode} ` +
        `selected=${decision.selected ?? 'none'} fallbacks=${decision.fallbacksTried.map((f) => `${f.backend}:${f.reason}`).join(',') || 'none'}`
    )
    // Structured line — see observability.ts's doc comment: this shape is
    // deliberately flat/JSON so it can go straight to a Supabase table
    // later without redesign. Until that table exists, this is the only
    // place the redacted, fully-typed log record (cost/usage fields the
    // line above doesn't carry) actually reaches anywhere.
    console.log('[model-router/caye-direct-bridge] invocation_log', JSON.stringify(buildInvocationLog({
      requestedMode: args.requestedMode,
      selectedBackend: decision.selected,
      fallbackSequence: decision.fallbacksTried,
      latencyMs: Date.now() - start,
      success: true,
      threadId: args.threadId,
      founderUserId: args.founderUserId,
    })))

    return {
      replyText: result.replyText,
      newTurns: result.newTurns,
      linkedThreadIds: result.linkedThreadIds,
      backend: decision.selected,
      richResult: result.richResult ? { ...result.richResult, provenance: { requestedMode: args.requestedMode, selectedBackend: decision.selected, provider: decision.selected?.includes('anthropic') || decision.selected === 'claude_subscription' ? 'anthropic' : decision.selected === 'openrouter' ? 'openrouter' : 'openai', model: result.model, fallbackSequence: decision.fallbacksTried, latencyMs: result.latencyMs ?? Date.now() - start, usage: result.usage } } : undefined,
    }
  } catch (err) {
    const failureSummary = err instanceof Error ? err.message : String(err)
    console.error(
      `[model-router/caye-direct-bridge] turn failed — thread=${args.threadId} requestedMode=${args.requestedMode} error=${failureSummary}`
    )
    console.error('[model-router/caye-direct-bridge] invocation_log', JSON.stringify(buildInvocationLog({
      requestedMode: args.requestedMode,
      selectedBackend: decision?.selected,
      fallbackSequence: decision?.fallbacksTried ?? [],
      latencyMs: Date.now() - start,
      success: false,
      failureSummary,
      threadId: args.threadId,
      founderUserId: args.founderUserId,
    })))
    throw err
  }
}
