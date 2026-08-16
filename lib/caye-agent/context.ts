import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { compactHistory } from './history-compaction'
import { getThread, getThreadEntities, describeEntity } from '@/lib/caye-direct-threads'
import { annotateHistoryWithRelativeTime } from './situation'
import { loadAgentTurnsForTriggers } from '@/lib/caye-frontdesk-agent-turns'

// Same bound as the operator sliding window (SLIDING_WINDOW_MESSAGES) —
// a Direct thread's own linked-message count is the natural cap here,
// there's no separate time window since a thread is explicitly meant to
// span days/weeks (unlike the operator window, which exists precisely to
// NOT do that).
const THREAD_WINDOW_MESSAGES = 60

// Sliding window bounds locked during the back-office grill-me, Q3:
// last 30 messages OR last 24h, whichever is shorter. For richer history
// the agent has read tools (get_recent_activity etc.) once those land.
const SLIDING_WINDOW_MESSAGES = 30
const SLIDING_WINDOW_HOURS = 24

/**
 * Load the operator↔Caye conversation history as a Claude MessageParam[].
 *
 * Prefers each row's persisted `claude_format` (rich shape including
 * assistant tool_use blocks + user tool_result blocks). Falls back to
 * reconstructing {role, content: body} from `direction` + `body` for
 * legacy rows that predate the column.
 *
 * Scoped to a single operator (not just the workspace) — a workspace can
 * have multiple operators (owner, staff, founder) sharing the back-office
 * channel, and each one's exchange with Caye needs its own memory. Before
 * this scoping existed, Caye's context mixed every operator's messages
 * together, so a reply to one operator could leak context from another's
 * unrelated conversation.
 *
 * Returns oldest-first so it can be passed straight to Claude.
 */
export async function loadOperatorContext(
  workspaceId: string,
  operatorAllowlistId: number | null
): Promise<Anthropic.MessageParam[]> {
  const supabase = createServiceClient()
  const cutoffISO = new Date(
    Date.now() - SLIDING_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString()

  let query = supabase
    .from('caye_operator_messages')
    .select('direction, body, claude_format, created_at')
    .eq('workspace_id', workspaceId)
    .gte('created_at', cutoffISO)

  query = operatorAllowlistId != null
    ? query.eq('operator_allowlist_id', operatorAllowlistId)
    : query.is('operator_allowlist_id', null)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(SLIDING_WINDOW_MESSAGES)

  if (error || !data) {
    console.warn('[caye-agent/context] history load failed:', error?.message)
    return []
  }

  // Walk newest→oldest from the DB, then reverse so Claude sees chronological.
  // Timestamps travel alongside each turn (index-aligned) so relative-time
  // markers can be applied below — see situation.ts for why this matters:
  // `created_at` was fetched here long before this change, but never made
  // it past this function into anything the model could read.
  const rows = data.reverse()
  const window: Anthropic.MessageParam[] = []
  const timestamps: (string | null)[] = []
  for (const row of rows) {
    const stored = row.claude_format as Anthropic.MessageParam | null | undefined
    if (stored && stored.role && stored.content !== undefined) {
      window.push(stored)
      timestamps.push((row.created_at as string | null) ?? null)
      continue
    }
    if (!row.body) continue
    window.push({
      role: row.direction === 'inbound' ? 'user' : 'assistant',
      content: row.body,
    })
    timestamps.push((row.created_at as string | null) ?? null)
  }

  const annotated = annotateHistoryWithRelativeTime(window, timestamps)

  // Spent tool results are 59.2% of the replayed bytes and the largest single
  // line item in the bill (see history-compaction.ts). Shrink the ones past
  // the verbatim budget — blocks and tool_use_ids are preserved, only stale
  // payloads shrink.
  return compactHistory(annotated)
}

export interface DirectThreadContext {
  history: Anthropic.MessageParam[]
  /** Rendered block for buildBackOfficeSystemPrompt's threadContext arg. Null for a brand-new, empty thread. */
  promptBlock: string | null
}

/**
 * Load context for a founder Caye Direct thread — the thread-scoped
 * counterpart to loadOperatorContext above. Deliberately a SEPARATE
 * function, not a parameter added to loadOperatorContext: WhatsApp's
 * context loading must stay exactly as it is (a continuous per-operator
 * relationship with no thread concept), per the core principle that
 * WhatsApp conversation and Caye Direct thread are not the same
 * abstraction. Only the founder-authoring path in
 * app/api/founder/caye-direct/threads/[id]/route.ts calls this.
 *
 * Pulls messages linked into this thread (via caye_direct_thread_messages,
 * not the operator sliding window) plus the thread's title/summary/linked
 * entities, rendered as a block the back-office prompt can drop in
 * verbatim — mirroring exactly how attentionContext is threaded in for
 * scan-origin turns (see modes/back-office.ts).
 */
export async function loadDirectThreadContext(
  workspaceId: string,
  threadId: string
): Promise<DirectThreadContext> {
  const supabase = createServiceClient()

  const [thread, entities] = await Promise.all([
    getThread(supabase, workspaceId, threadId),
    getThreadEntities(supabase, threadId),
  ])

  const { data: links } = await supabase
    .from('caye_direct_thread_messages')
    .select('message_id')
    .eq('thread_id', threadId)
  const messageIds = (links ?? []).map((r) => r.message_id as string)

  let history: Anthropic.MessageParam[] = []
  if (messageIds.length > 0) {
    const { data, error } = await supabase
      .from('caye_operator_messages')
      .select('direction, body, claude_format, created_at')
      .in('id', messageIds)
      .order('created_at', { ascending: true })
      .limit(THREAD_WINDOW_MESSAGES)

    if (error || !data) {
      console.warn('[caye-agent/context] thread history load failed:', error?.message)
    } else {
      const rawHistory: Anthropic.MessageParam[] = []
      const rawTimestamps: (string | null)[] = []
      for (const row of data) {
        const stored = row.claude_format as Anthropic.MessageParam | null | undefined
        if (stored && stored.role && stored.content !== undefined) {
          rawHistory.push(stored)
          rawTimestamps.push((row.created_at as string | null) ?? null)
          continue
        }
        if (!row.body) continue
        rawHistory.push({ role: row.direction === 'inbound' ? 'user' : 'assistant', content: row.body })
        rawTimestamps.push((row.created_at as string | null) ?? null)
      }
      history = compactHistory(annotateHistoryWithRelativeTime(rawHistory, rawTimestamps))
    }
  }

  if (!thread) return { history, promptBlock: null }

  const lines: string[] = []
  lines.push(`- Thread title: ${thread.title || '(untitled — this is the first exchange)'}`)
  if (thread.summary?.trim()) {
    lines.push(`- Rolling summary of everything before the recent messages below: ${thread.summary.trim()}`)
  }
  if (entities.length > 0) {
    const labels = await Promise.all(entities.map((e) => describeEntity(supabase, e)))
    lines.push(`- Linked to: ${labels.join('; ')}`)
  }

  const promptBlock =
    lines.length > 0
      ? [
          'YOU ARE INSIDE A CAYE DIRECT THREAD — a persistent, topic-scoped conversation with the founder, not a fresh chat.',
          ...lines,
          '- This thread can span days or weeks. Recent turns follow below; treat the summary line (if present) as established fact, not something to re-derive.',
        ].join('\n')
      : null

  return { history, promptBlock }
}

// Dual bound, same shape as the operator sliding window (SLIDING_WINDOW_*
// above): whichever cap is smaller wins. A customer relationship can
// legitimately run for weeks between a booking and a follow-up question, so
// the day bound is generous rather than WhatsApp's 24h operator window —
// but a single burst of back-and-forth shouldn't replay unboundedly either.
const FRONT_DESK_WINDOW_MESSAGES = 40
const FRONT_DESK_WINDOW_DAYS = 14

/**
 * Load a customer conversation as real, ordered, multi-turn history —
 * PHASE 1 of runtime convergence (2026-08-16). Generalizes the same
 * mechanism `loadOperatorContext` already uses (persisted rows → real
 * `MessageParam[]`, relative-time annotation, `compactHistory` budgeting)
 * to the front-desk data source (`unified_messages`) instead of the
 * back-office one (`caye_operator_messages`).
 *
 * NOT wired into any production webhook in this phase. `lib/caye-reply.ts`
 * continues to use its own `fetchConversationHistory` +
 * `formatHistoryBlock` (single flattened string, no timestamps, hard
 * 10-message cap) for live customer traffic — see the architectural audit
 * for why that pattern is the thing this phase is building the replacement
 * for, and the convergence plan for why production traffic isn't switched
 * onto it yet. This function exists so the situation assembler and the
 * replay harness can evaluate the richer alternative against real history
 * without touching what customers currently receive.
 *
 * PHASE 3 (2026-08-16) addition: for each customer (inbound) row in the
 * window, checks `caye_frontdesk_agent_turns` (see
 * lib/caye-frontdesk-agent-turns.ts) for persisted turns keyed to that
 * row's id. Where they exist, they SUPERSEDE both the flattened
 * `{role:user}` reconstruction of that row and the flattened
 * `{role:assistant}` reconstruction of the reply that followed it — the
 * persisted sequence already contains a user turn for the same customer
 * message plus any tool_use/tool_result turns plus the final assistant
 * text turn, so replaying both would duplicate the exchange. Rows with no
 * persisted turns (pre-Phase-3 history, or any invocation path not yet
 * writing to the table) fall back to the plain-text reconstruction
 * exactly as before — the same nullable-column fallback shape
 * `loadOperatorContext` already uses for `claude_format`, adapted to a
 * separate table instead of a column.
 */
export async function loadFrontDeskConversationContext(
  conversationId: string,
  excludeChannelMessageId: string | null = null
): Promise<{ history: Anthropic.MessageParam[]; historyTimestamps: (string | null)[] }> {
  const supabase = createServiceClient()
  const cutoffISO = new Date(Date.now() - FRONT_DESK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('unified_messages')
    .select('id, sender_type, content, sent_at, channel_message_id')
    .eq('conversation_id', conversationId)
    .eq('is_internal', false)
    .gte('sent_at', cutoffISO)
    .order('sent_at', { ascending: false })
    .limit(FRONT_DESK_WINDOW_MESSAGES)

  if (error || !data) {
    console.warn('[caye-agent/context] front-desk history load failed:', error?.message)
    return { history: [], historyTimestamps: [] }
  }

  const rows = data
    .filter((r) => !excludeChannelMessageId || r.channel_message_id !== excludeChannelMessageId)
    .reverse()

  const customerMessageIds = rows
    .filter((r) => r.sender_type === 'customer')
    .map((r) => r.id as string)
  const agentTurnsByTrigger = await loadAgentTurnsForTriggers(supabase, conversationId, customerMessageIds)

  const history: Anthropic.MessageParam[] = []
  const timestamps: (string | null)[] = []
  let skipUntilNextCustomerRow = false
  for (const row of rows) {
    const isCustomer = row.sender_type === 'customer'
    if (isCustomer) skipUntilNextCustomerRow = false

    const persistedTurns = isCustomer ? agentTurnsByTrigger.get(row.id as string) : undefined
    if (persistedTurns && persistedTurns.length > 0) {
      for (const turn of persistedTurns) {
        history.push(turn.claude_format)
        timestamps.push(turn.created_at)
      }
      skipUntilNextCustomerRow = true
      continue
    }

    if (skipUntilNextCustomerRow) continue

    const content = (row.content as string | null) ?? ''
    if (!content.trim()) continue
    history.push({
      role: isCustomer ? 'user' : 'assistant',
      content,
    })
    timestamps.push((row.sent_at as string | null) ?? null)
  }

  return {
    history: compactHistory(annotateHistoryWithRelativeTime(history, timestamps)),
    historyTimestamps: timestamps,
  }
}
