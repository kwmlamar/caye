import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { runInvestigation } from './investigation'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { resolveFounderOperator } from '@/lib/operator-identity'
import {
  getThread,
  setThreadStatus,
  touchThread,
  linkMessageToThread,
  linkInsertedMessagesToThreads,
} from '@/lib/caye-direct-threads'
import { maybeGenerateThreadTitle, maybeRefreshThreadSummary } from '@/lib/caye-direct-threads-summarize'
import { runCayeDirectRouterTurn } from '@/lib/model-router/caye-direct-bridge'
import type { BackendId, RequestedMode } from '@/lib/model-router/types'
import type { RichResult } from '@/lib/caye-direct-rich-results'
import { engineeringRichResult } from '@/lib/engineering/rich-result'
import { engineeringAnalysisRichResult } from '@/lib/engineering/fea/rich-result'
import { resolveWorkspaceAttachments, buildAttachmentContentBlocks, MAX_ATTACHMENTS_PER_TURN } from '@/lib/artifacts/attachments'
import { businessArtifactRichResult, mergeRichResults } from '@/lib/artifacts/rich-result'
import { propertyRichResultFromTurns } from '@/lib/property/turn-rich-result'

export interface FounderThreadTurnResult {
  replyText: string
  threadId: string
  /** Which backend actually served this turn — only set on the model-router path (options.requestedMode present). */
  backend?: BackendId
  richResult?: RichResult
}

/**
 * Selects a subscription/API model via lib/model-router instead of the
 * production cayeAgent()/execute.ts path. Strictly opt-in: `requestedMode`
 * is undefined for every caller that doesn't explicitly pass it, which
 * includes app/api/founder/caye-direct/voice/turn/route.ts — voice keeps
 * calling runFounderThreadTurn with its original 3-arg shape and gets
 * EXACTLY today's behavior, unaffected by this option existing. Only the
 * text route's new model selector (2026-08-17) sends this.
 */
export interface FounderThreadTurnOptions {
  requestedMode?: RequestedMode
  /** Required (and only meaningful) when requestedMode is set — the verified founder auth.users.id from requireFounder(), never client-supplied. */
  founderUserId?: string
}

/**
 * Runs one founder Caye Direct thread turn end to end: resumes an archived
 * thread, inserts the inbound row, runs the SAME cayeAgent()/runToolLoop
 * back-office agent (tools, role gating, the high-risk confirmation gate,
 * action-grounding) as every other caller, persists the resulting turns,
 * links them to the thread, and kicks off title/summary maintenance.
 *
 * Extracted from POST /api/founder/caye-direct/threads/[id]/route.ts
 * (2026-08-16 live voice work) so the voice turn route
 * (app/api/founder/caye-direct/voice/turn/route.ts) can send a
 * voice-finalized transcript through the exact same authorization and
 * persistence path as a typed message — a spoken turn is indistinguishable
 * from a typed one to cayeAgent, gateHighRisk, or action-claim-guard. The
 * text route below is now a thin wrapper around this function; its
 * observable behavior (request/response shape, status codes) is unchanged.
 *
 * ATTACHMENTS (multimodal Caye Direct follow-up). `attachmentArtifactIds`
 * names business_artifacts the client already uploaded via
 * app/api/founder/caye-direct/attachments/route.ts BEFORE this call — never
 * raw bytes in this request. Every id is re-resolved against THIS
 * workspace (resolveWorkspaceAttachments), so a forged or foreign-workspace
 * id throws rather than silently being trusted. A message with at least
 * one attachment and empty text is allowed (`message` may be '').
 *
 * When attachments are present, this ALWAYS runs the production
 * cayeAgent()/runInvestigation path, ignoring `options.requestedMode` —
 * live image/document reading is only wired for that path (mirrors the
 * WhatsApp operator webhook's own vision/document turn); the multi-backend
 * model router (runCayeDirectRouterTurn) is a separate, unrelated surface
 * this doesn't extend, since threading raw content blocks through
 * OpenAI-compatible backends would be new, unproven surface area, not a
 * requirement of this feature.
 */
export async function runFounderThreadTurn(
  workspaceId: string,
  threadId: string,
  message: string,
  options?: FounderThreadTurnOptions,
  attachmentArtifactIds?: readonly string[]
): Promise<FounderThreadTurnResult> {
  const supabase = createServiceClient()

  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread) throw new Error('Thread not found')

  // Sending into an archived thread resumes it — see the POST handler's
  // original comment for why (archiving is a visibility toggle, not a close).
  if (thread.status === 'archived') {
    await setThreadStatus(supabase, workspaceId, threadId, 'active')
  }

  const operator = await resolveFounderOperator(supabase, workspaceId)
  const callerName = operator?.name ?? 'Founder (dashboard)'

  const hasAttachments = !!attachmentArtifactIds?.length
  let attachmentRichResult: RichResult | undefined
  let userMessageOverride: Anthropic.MessageParam['content'] | undefined
  if (hasAttachments) {
    if (attachmentArtifactIds!.length > MAX_ATTACHMENTS_PER_TURN) throw new Error('Too many attachments')
    const { resolved, invalidIds } = await resolveWorkspaceAttachments(workspaceId, attachmentArtifactIds!)
    // A forged id, a foreign-workspace id, or one that never finished
    // storing is refused outright rather than silently dropped — see
    // resolveWorkspaceAttachments's doc comment. No message is persisted.
    if (invalidIds.length > 0) throw new Error('Invalid attachment')

    attachmentRichResult = businessArtifactRichResult(resolved.map((r) => r.artifact.id))
    const { blocks, unreadableNote } = await buildAttachmentContentBlocks(resolved)
    // HARD INVARIANT (attachment-routing safety): an attachment must never
    // be silently answered without the model actually seeing it. This is
    // NOT the routine "this modality has no inline-read path yet" case
    // (buildAttachmentContentBlocks handles that gracefully via
    // unreadableNote while still forwarding any OTHER attachment's real
    // bytes) — today's composer only accepts image/PDF, both inline-
    // readable, so `blocks` is empty here only when byte download itself
    // failed for every attachment (e.g. a storage outage). Fail the turn
    // explicitly rather than let the model respond as if nothing was ever
    // attached — no message is persisted, mirroring the invalid-id case
    // above exactly.
    if (blocks.length === 0) throw new Error('Attachment unreadable')
    const trailingText = [message.trim(), unreadableNote].filter(Boolean).join('\n\n')
    userMessageOverride = [...blocks, ...(trailingText ? [{ type: 'text' as const, text: trailingText }] : [])]
  }

  const placeholderBody = message.trim() || (hasAttachments ? '[attachment]' : '')
  const { data: inboundRow } = await supabase
    .from('caye_operator_messages')
    .insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: null,
      body: placeholderBody,
      intent: null,
      claude_format: { role: 'user', content: placeholderBody },
      operator_allowlist_id: operator?.id ?? null,
      operator_name: operator?.name ?? null,
      operator_role: operator?.role ?? 'founder',
      origin: 'dashboard',
      rich_result: attachmentRichResult ?? null,
    })
    .select('id')
    .single()
  if (!inboundRow?.id) throw new Error('Could not persist founder message')
  await linkMessageToThread(supabase, threadId, inboundRow.id, 'founder')

  // Persists one pass's turns immediately, rather than accumulating turns
  // across an entire (possibly multi-pass) investigation in memory and
  // writing once at the end. This bounds the crash-loss window to "the pass
  // that's currently in flight" — the same window an ordinary single-pass
  // turn always had — instead of letting it grow to "everything since the
  // investigation started" across up to 1 + MAX_INVESTIGATION_CONTINUATIONS
  // passes. caye_tool_calls rows (investigation.ts's ledger) are already
  // durable per tool call regardless; this is about the founder-visible
  // conversational transcript in caye_operator_messages, which previously
  // only existed in memory until the very last line of this function.
  async function persistPassTurns(
    turns: Anthropic.MessageParam[],
    linkedThreadIds: string[],
    engineeringArtifactIds: string[] = [],
    businessArtifactIds: string[] = [],
    engineeringAnalysisIds: string[] = []
  ): Promise<void> {
    if (turns.length === 0) return
    const propertyResult = propertyRichResultFromTurns(turns)
    const richResult = mergeRichResults(
      mergeRichResults(
        mergeRichResults(engineeringRichResult(engineeringArtifactIds), businessArtifactRichResult(businessArtifactIds)),
        engineeringAnalysisRichResult(engineeringAnalysisIds)
      ),
      propertyResult
    )
    const inserted = await persistAgentTurns(supabase, workspaceId, turns, operator, undefined, undefined, 'dashboard', 'visible', richResult)
    const insertedIds = inserted.map((r) => r.id)
    await Promise.all([
      ...insertedIds.map((id) => linkMessageToThread(supabase, threadId, id, 'founder')),
      linkInsertedMessagesToThreads(supabase, insertedIds, linkedThreadIds),
    ])
  }

  // Attachments only ever run the production runInvestigation path below —
  // see this function's doc comment for why the router is skipped rather
  // than extended.
  const usingRouter = !!(options?.requestedMode && options.founderUserId) && !hasAttachments

  // HARD INVARIANT (attachment-routing safety), not just correct-by-
  // construction boolean logic above: the model-router bridge
  // (runCayeDirectRouterTurn) has no wiring at all to receive
  // userMessageOverride's real content blocks — it only ever sees
  // `message` (plain text). An attachment reaching that path would be
  // silently invisible to whichever backend served the turn. This can
  // never actually trip given the `&& !hasAttachments` clause above, but
  // it exists so a future refactor of that boolean can fail loudly here
  // instead of silently dropping an attachment.
  if (hasAttachments && usingRouter) {
    throw new Error('Attachment routing invariant violated: attachments must never reach the model-router path')
  }

  if (usingRouter) {
    // Router path is unchanged: single call, single persist, exactly as
    // before this feature existed. ranOutOfIterations/continuation is a
    // runToolLoop-specific concept the router bridge doesn't produce —
    // see model-router/types.ts's "nothing here is wired into
    // lib/caye-agent/execute.ts" — so there is nothing to continue here.
    const routerResult = await runCayeDirectRouterTurn({
      workspaceId,
      threadId,
      founderUserId: options!.founderUserId!,
      callerName,
      operatorId: operator?.id ?? null,
      message,
      requestedMode: options!.requestedMode!,
      engineeringOrigin: { threadId, messageId: inboundRow.id },
      channel: 'dashboard',
    })
    const richResult = mergeRichResults(
      mergeRichResults(
        mergeRichResults(
          mergeRichResults(engineeringRichResult(routerResult.engineeringArtifactIds ?? []), businessArtifactRichResult(routerResult.businessArtifactIds ?? [])),
          engineeringAnalysisRichResult(routerResult.engineeringAnalysisIds ?? [])
        ),
        propertyRichResultFromTurns(routerResult.newTurns)
      ),
      routerResult.richResult
    )
    const inserted = await persistAgentTurns(supabase, workspaceId, routerResult.newTurns, operator, undefined, undefined, 'dashboard', 'visible', richResult)
    const insertedIds = inserted.map((r) => r.id)
    await Promise.all([...insertedIds.map((id) => linkMessageToThread(supabase, threadId, id, 'founder')), linkInsertedMessagesToThreads(supabase, insertedIds, routerResult.linkedThreadIds)])
    await touchThread(supabase, threadId)
    await maybeGenerateThreadTitle(workspaceId, threadId)
    void maybeRefreshThreadSummary(workspaceId, threadId).catch(() => {})
    return { replyText: routerResult.replyText, threadId, backend: routerResult.backend, richResult }
  }

  // Bounded automatic continuation (2026-08-17 Bimini revenue-audit fix) —
  // see investigation.ts for the full mechanism (why this exists, how the
  // continuation budget and grounded exhaustion summary work).
  const agentResult = await runInvestigation(
    supabase,
    {
      workspaceId,
      threadId,
      message,
      callerName,
      operatorId: operator?.id ?? null,
      engineeringOrigin: { threadId, messageId: inboundRow.id },
      channel: 'dashboard',
      userMessageOverride,
    },
    persistPassTurns
  )

  await touchThread(supabase, threadId)
  await maybeGenerateThreadTitle(workspaceId, threadId)
  void maybeRefreshThreadSummary(workspaceId, threadId).catch(() => {})

  return {
    replyText: agentResult.replyText,
    threadId,
    richResult: mergeRichResults(
      mergeRichResults(
        mergeRichResults(engineeringRichResult(agentResult.engineeringArtifactIds ?? []), businessArtifactRichResult(agentResult.businessArtifactIds ?? [])),
        engineeringAnalysisRichResult(agentResult.engineeringAnalysisIds ?? [])
      ),
      propertyRichResultFromTurns(agentResult.newTurns)
    ),
  }
}
