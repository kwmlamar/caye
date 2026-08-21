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

export interface FounderThreadTurnResult {
  replyText: string
  threadId: string
  /** Which backend actually served this turn — only set on the model-router path (options.requestedMode present). */
  backend?: BackendId
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
 */
export async function runFounderThreadTurn(
  workspaceId: string,
  threadId: string,
  message: string,
  options?: FounderThreadTurnOptions
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

  const { data: inboundRow } = await supabase
    .from('caye_operator_messages')
    .insert({
      workspace_id: workspaceId,
      direction: 'inbound',
      wa_message_id: null,
      body: message,
      intent: null,
      claude_format: { role: 'user', content: message },
      operator_allowlist_id: operator?.id ?? null,
      operator_name: operator?.name ?? null,
      operator_role: operator?.role ?? 'founder',
      origin: 'dashboard',
    })
    .select('id')
    .single()
  if (inboundRow?.id) await linkMessageToThread(supabase, threadId, inboundRow.id, 'founder')

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
  async function persistPassTurns(turns: Anthropic.MessageParam[], linkedThreadIds: string[]): Promise<void> {
    if (turns.length === 0) return
    const inserted = await persistAgentTurns(supabase, workspaceId, turns, operator, undefined, undefined, 'dashboard')
    const insertedIds = inserted.map((r) => r.id)
    await Promise.all([
      ...insertedIds.map((id) => linkMessageToThread(supabase, threadId, id, 'founder')),
      linkInsertedMessagesToThreads(supabase, insertedIds, linkedThreadIds),
    ])
  }

  const usingRouter = !!(options?.requestedMode && options.founderUserId)

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
    })
    await persistPassTurns(routerResult.newTurns, routerResult.linkedThreadIds)
    await touchThread(supabase, threadId)
    await maybeGenerateThreadTitle(workspaceId, threadId)
    void maybeRefreshThreadSummary(workspaceId, threadId).catch(() => {})
    return { replyText: routerResult.replyText, threadId, backend: routerResult.backend }
  }

  // Bounded automatic continuation (2026-08-17 Bimini revenue-audit fix) —
  // see investigation.ts for the full mechanism (why this exists, how the
  // continuation budget and grounded exhaustion summary work).
  const agentResult = await runInvestigation(
    supabase,
    { workspaceId, threadId, message, callerName, operatorId: operator?.id ?? null },
    persistPassTurns
  )

  await touchThread(supabase, threadId)
  await maybeGenerateThreadTitle(workspaceId, threadId)
  void maybeRefreshThreadSummary(workspaceId, threadId).catch(() => {})

  return { replyText: agentResult.replyText, threadId }
}
