import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { getThread, getThreadMessages } from '@/lib/caye-direct-threads'
import { isInternalTurnBody, visibleBody } from '@/lib/caye-operator-messages'

// Same cheap tier used by lib/whatsapp/intent.ts's classifier — a title or
// a summary is a small, low-stakes, single-shot text task, not something
// that needs the main agent model.
const CHEAP_MODEL = 'claude-haiku-4-5-20251001'

// Below this many linked messages, a thread's own history is already
// cheap enough to replay in full — summarizing it would cost more than it
// saves. Matches the "lazy, not per-message" principle: most threads
// never cross this and never get a summary at all.
const SUMMARY_TRIGGER_MESSAGE_COUNT = 20

/**
 * One-shot title generation for a founder-created Direct thread, fired
 * exactly once after the first assistant reply (never re-run per message
 * — see caye-direct-threads plan). Caye-initiated threads skip this
 * entirely; the calling job already knows the category and passes a
 * titleHint straight into getOrCreateDirectThread.
 *
 * Best-effort: a failure here leaves the thread untitled (UI shows "New
 * conversation") rather than blocking the reply the founder is waiting on.
 */
export async function maybeGenerateThreadTitle(workspaceId: string, threadId: string): Promise<void> {
  const supabase = createServiceClient()
  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread || thread.title) return

  const rows = await getThreadMessages(supabase, threadId, 6)
  const visible = rows.filter((r) => !isInternalTurnBody(r.body)).map((r) => visibleBody(r.body))
  if (visible.length === 0) return

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await loggedMessagesCreate(
      client,
      {
        model: CHEAP_MODEL,
        max_tokens: 20,
        system:
          'You title a short conversation snippet in 2-6 words. Describe the SUBJECT, not the fact that it\'s a conversation. No punctuation at the end, no quotes, no "Conversation about". Examples: "Emily pricing exception", "August bookings", "Deposit policy". Reply with the title only.',
        messages: [{ role: 'user', content: visible.join('\n\n').slice(0, 2000) }],
      },
      { source: 'lib/caye-direct-threads-summarize.ts:maybeGenerateThreadTitle', workspaceId }
    )
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text?.trim()
    const title = text?.replace(/^["']|["']$/g, '').slice(0, 80)
    if (title) {
      await supabase
        .from('caye_direct_threads')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', threadId)
        .is('title', null)
    }
  } catch (err) {
    console.warn('[caye-direct-threads-summarize] title generation failed:', err)
  }
}

/**
 * Lazily refresh a thread's rolling summary once its linked-message count
 * has grown past SUMMARY_TRIGGER_MESSAGE_COUNT since the last summary
 * (or since thread creation, if it's never been summarized). NOT Memory —
 * this is discarded/regenerated freely from the raw messages and never
 * written to business_facts/caye_standing_rules/customer-profile. Lets a
 * long-idle thread resume without replaying its full history — see
 * loadDirectThreadContext, which reads thread.summary directly.
 *
 * Reuses the same prompt-based condense + safe-fallback shape as
 * app/api/caye/chat/route.ts's summarizer, on the cheap tier instead of
 * the main agent model.
 */
export async function maybeRefreshThreadSummary(workspaceId: string, threadId: string): Promise<void> {
  const supabase = createServiceClient()
  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread) return

  const rows = await getThreadMessages(supabase, threadId, 500)
  const visible = rows.filter((r) => !isInternalTurnBody(r.body))
  if (visible.length < SUMMARY_TRIGGER_MESSAGE_COUNT) return

  // Rough dedupe against re-summarizing on every message once the
  // threshold is crossed: only refresh again after another full
  // threshold's worth of new messages since the last refresh.
  if (thread.summary_updated_at) {
    const sinceLastSummary = visible.filter((r) => r.created_at > thread.summary_updated_at!).length
    if (sinceLastSummary < SUMMARY_TRIGGER_MESSAGE_COUNT) return
  }

  const transcript = visible
    .map((r) => `${r.direction === 'inbound' ? (r.operator_name ?? 'Operator') : 'Caye'}: ${visibleBody(r.body)}`)
    .join('\n')
    .slice(0, 12000)

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await loggedMessagesCreate(
      client,
      {
        model: CHEAP_MODEL,
        max_tokens: 300,
        system:
          'Condense this conversation thread into a compact briefing for someone resuming it later. Cover: current topic/objective, important facts, decisions made, unresolved questions, actions taken or planned. 3-6 short sentences, plain prose, no headers or bullet points. This is a working summary, not a transcript — omit pleasantries and small talk.',
        messages: [{ role: 'user', content: transcript }],
      },
      { source: 'lib/caye-direct-threads-summarize.ts:maybeRefreshThreadSummary', workspaceId }
    )
    const summary = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text?.trim()
    if (summary) {
      await supabase
        .from('caye_direct_threads')
        .update({ summary, summary_updated_at: new Date().toISOString() })
        .eq('id', threadId)
    }
  } catch (err) {
    // Fallback: no summary is safer than a stale/wrong one. The thread
    // still functions — loadDirectThreadContext just replays more raw
    // history until a future call succeeds.
    console.warn('[caye-direct-threads-summarize] summary refresh failed:', err)
  }
}
