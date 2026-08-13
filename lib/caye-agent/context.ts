import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { compactHistory } from './history-compaction'
import { getThread, getThreadEntities, describeEntity } from '@/lib/caye-direct-threads'

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
  const window = data
    .reverse()
    .map((row): Anthropic.MessageParam | null => {
      const stored = row.claude_format as Anthropic.MessageParam | null | undefined
      if (stored && stored.role && stored.content !== undefined) {
        return stored
      }
      if (!row.body) return null
      return {
        role: row.direction === 'inbound' ? 'user' : 'assistant',
        content: row.body,
      }
    })
    .filter((m): m is Anthropic.MessageParam => m !== null)

  // Spent tool results are 59.2% of the replayed bytes and the largest single
  // line item in the bill (see history-compaction.ts). Shrink the ones past
  // the verbatim budget — blocks and tool_use_ids are preserved, only stale
  // payloads shrink.
  return compactHistory(window)
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
      history = data
        .map((row): Anthropic.MessageParam | null => {
          const stored = row.claude_format as Anthropic.MessageParam | null | undefined
          if (stored && stored.role && stored.content !== undefined) return stored
          if (!row.body) return null
          return { role: row.direction === 'inbound' ? 'user' : 'assistant', content: row.body }
        })
        .filter((m): m is Anthropic.MessageParam => m !== null)
      history = compactHistory(history)
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
