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
import { FOUNDER_DIRECT_EVIDENCE_GUIDANCE } from './caye-direct-evidence-guidance'
import { voiceReadToolHints } from '@/lib/caye-voice/read-tool-hints'

const VOICE_MAX_OUTPUT_TOKENS = 1600

const FOUNDER_DIRECT_REASONING_GUIDANCE = `FOUNDER DIRECT — SYNTHESIZE BEFORE YOU DECLARE SOMETHING UNDEFINED
- The founder is using Caye Direct as an operating/thinking interface, not merely querying configured database objects.
- Treat explicit goals, standing rules, and saved memory as authoritative signals when they exist, but do NOT equate "no formal goal row" with "no priorities" or "nothing to focus on".
- For broad questions such as "what are our current priorities?", "what matters right now?", "what should we focus on?", "how are we doing?", or similar operating-status questions, inspect the current workspace with the available READ tools before answering when the answer is not already pinned authoritatively in context.
- Synthesize the smallest useful ranked view from real evidence: active/upcoming customer commitments, unresolved conversations, bookings, leads/sales state, pending work or approvals, channel/integration gaps, owner-attention items, recent corrections, and explicit workspace goals where present.
- If priorities are inferred rather than owner-defined, say that plainly in one short clause (for example: "No owner-defined priorities are saved, so these are the priorities I infer from current operations.") and then give the inferred priorities. Do not stop at the absence of formal goals and ask the founder to configure them first.
- Never invent a priority merely to fill a list. Ground each inferred item in current workspace evidence; if evidence is genuinely too thin, state what is known and what is missing.
- Operator/global Direction and per-workspace business state are different scopes. Do not leak operator-global goals into a customer workspace unless they are explicitly available in the scoped context.`

const VOICE_DELIVERY_GUIDANCE = `SPOKEN DELIVERY — this reply will be read aloud, not displayed
- Answer in at most two or three short sentences. Lead with the answer, not the reasoning.
- Speak like a capable human operator summarizing what matters, not like a database export being read aloud.
- Never read raw rows one by one when a tool returns a list. Compress the result into a natural summary: give the total, group or characterize the items, mention only the most useful examples, and surface any standout exception or risk.
- If there are more than five list items, do not enumerate them all unless the founder explicitly asks for the full list. Mention at most three or four representative items, then say the full list is in the thread.
- Do not repeat the same date, visibility label, guest count, status, or other field on every item. State shared facts once, then call out only differences that matter.
- Prefer phrasing such as "You have fifteen tours listed for tomorrow; most are public, with one private option" over fifteen separate lines that each repeat the date and status.
- No markdown, no bullet points, no numbered lists, no tables, no headings, no URLs read out character by character.
- Say numbers the way a person says them out loud ("about twelve hundred", "the third").
- If the full answer genuinely needs more detail than fits in a breath or two, give the headline out loud and say the rest is in the thread.
- Never omit a warning, an approval requirement, a failure, or an uncertainty to save words. Brevity applies to detail, never to risk.`

export interface CayeDirectRouterTurnArgs {
  workspaceId: string
  threadId: string
  founderUserId: string
  callerName: string | null
  operatorId: number | null
  message: string
  requestedMode: RequestedMode
  restrictToToolNames?: readonly string[]
  engineeringOrigin?: { threadId: string; messageId: string }
  channel?: 'dashboard'
  responseStyle?: 'voice'
}

export interface CayeDirectRouterTurnResult {
  replyText: string
  newTurns: Anthropic.MessageParam[]
  linkedThreadIds: string[]
  backend?: BackendId
  model?: string
  richResult?: RichResult
  engineeringArtifactIds?: string[]
  engineeringAnalysisIds?: string[]
  businessArtifactIds?: string[]
}

function backendsFor(): ToolCapableBackend[] {
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
  const engineeringArtifactIds: string[] = []
  const engineeringAnalysisIds: string[] = []
  const businessArtifactIds: string[] = []
  const toolCtx: ToolContext = {
    workspaceId: args.workspaceId,
    callerRole: 'founder',
    operatorId: args.operatorId,
    requestId: randomUUID(),
    directThreadLinks,
    engineeringOrigin: args.engineeringOrigin,
    channel: args.channel,
    engineeringArtifactIds,
    engineeringAnalysisIds,
    businessArtifactIds,
  }
  Object.assign(toolCtx, { founderUserId: args.founderUserId })

  const isVoice = args.responseStyle === 'voice'
  const voiceToolHints = isVoice ? voiceReadToolHints(args.message) : undefined
  const restrictedToolNames = args.restrictToToolNames ?? voiceToolHints
  const start = Date.now()
  let decision: RouterDecision | undefined
  try {
    const sharedGuidance = `${systemPrompt}\n\n${FOUNDER_DIRECT_REASONING_GUIDANCE}\n\n${FOUNDER_DIRECT_EVIDENCE_GUIDANCE}`
    const result = await runFounderToolLoop({
      ctx,
      requestedMode: args.requestedMode,
      backends: backendsFor(),
      toolCtx,
      system: isVoice ? `${sharedGuidance}\n\n${VOICE_DELIVERY_GUIDANCE}` : sharedGuidance,
      initialMessages,
      signal: AbortSignal.timeout(180_000),
      restrictToToolNames: restrictedToolNames,
      ...(isVoice ? { maxOutputTokens: VOICE_MAX_OUTPUT_TOKENS } : {}),
    })
    decision = result.decision

    console.log(
      `[model-router/caye-direct-bridge] turn served — thread=${args.threadId} requestedMode=${args.requestedMode} ` +
        `selected=${decision.selected ?? 'none'} fallbacks=${decision.fallbacksTried.map((f) => `${f.backend}:${f.reason}`).join(',') || 'none'} ` +
        `voiceTools=${voiceToolHints?.join(',') || 'full'}`
    )
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
      ...([...new Set(engineeringArtifactIds)].length ? { engineeringArtifactIds: [...new Set(engineeringArtifactIds)] } : {}),
      ...([...new Set(engineeringAnalysisIds)].length ? { engineeringAnalysisIds: [...new Set(engineeringAnalysisIds)] } : {}),
      ...([...new Set(businessArtifactIds)].length ? { businessArtifactIds: [...new Set(businessArtifactIds)] } : {}),
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
