import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { createRoutineInferenceLogger, runInference, type RoutineParseResult } from '@/lib/routine-inference'
import { getThread, getThreadMessages, type ThreadMessageRow } from '@/lib/caye-direct-threads'
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
const TITLE_WORKLOAD = 'caye_direct_thread_title'

const FRONTIER_TITLE_SYSTEM =
  'You title a short conversation snippet in 2-6 words. Describe the SUBJECT, not the fact that it\'s a conversation. No punctuation at the end, no quotes, no "Conversation about". Examples: "Emily pricing exception", "August bookings", "Deposit policy". Reply with the title only.'

const ROUTINE_TITLE_SYSTEM =
  'Classify a founder-only conversation snippet into a sidebar title. Return ONLY JSON matching exactly {"kind":"title","title":"2-6 word subject"} or {"kind":"escalate"}. Use escalate when the subject is ambiguous. A title must be 2-6 plain words, at most 80 characters, without quotes or ending punctuation. It is display-only and must describe the subject, not that this is a conversation.'

/**
 * Build title input from the first actually completed founder -> Caye exchange.
 *
 * Voice title generation is deliberately deferred off the reply critical path.
 * That means another turn can arrive before the title job runs. Using "the
 * first N visible messages" made the title workload race with later turns and
 * occasionally describe the wrong subject. This helper pins title evidence to
 * one completed turn: first visible inbound founder message plus the first
 * visible outbound Caye message after it. If the reply has not persisted yet,
 * return null and leave the thread honestly untitled rather than guessing.
 */
export function completedTitleTranscript(rows: readonly ThreadMessageRow[]): string | null {
  const visible = rows.filter((row) => !isInternalTurnBody(row.body))
  const founderIndex = visible.findIndex((row) => row.direction === 'inbound')
  if (founderIndex < 0) return null
  const reply = visible.slice(founderIndex + 1).find((row) => row.direction === 'outbound')
  if (!reply) return null

  const founder = visibleBody(visible[founderIndex].body).trim()
  const caye = visibleBody(reply.body).trim()
  if (!founder || !caye) return null
  return `Founder: ${founder}\n\nCaye: ${caye}`.slice(0, 2000)
}

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

  // Read enough history to tolerate tool/internal rows between the first
  // founder message and the first persisted final reply. The helper below
  // still uses exactly one completed visible exchange.
  const rows = await getThreadMessages(supabase, threadId, 40)
  const transcript = completedTitleTranscript(rows)
  if (!transcript) return

  try {
    const title = await runInference({
      tier: 'routine',
      frontierModel: CHEAP_MODEL,
      frontier: () => generateThreadTitleWithFrontier(transcript, workspaceId),
      routine: {
        system: ROUTINE_TITLE_SYSTEM,
        messages: [{ role: 'user', content: transcript }],
        maxOutputTokens: 60,
        parse: parseRoutineThreadTitle,
      },
      onMetadata: createRoutineInferenceLogger(TITLE_WORKLOAD),
    })
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

/** The original title generation path, retained verbatim as routine fallback. */
async function generateThreadTitleWithFrontier(transcript: string, workspaceId: string): Promise<string | null> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await loggedMessagesCreate(
    client,
    {
      model: CHEAP_MODEL,
      max_tokens: 20,
      system: FRONTIER_TITLE_SYSTEM,
      messages: [{ role: 'user', content: transcript }],
    },
    { source: 'lib/caye-direct-threads-summarize.ts:maybeGenerateThreadTitle', workspaceId }
  )
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text?.trim()
  return text?.replace(/^["']|["']$/g, '').slice(0, 80) ?? null
}

/** Strictly accepts the bounded routine schema; all uncertainty escalates. */
export function parseRoutineThreadTitle(content: string): RoutineParseResult<string | null> {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('routine thread title was not JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('routine thread title was not an object')
  const record = value as Record<string, unknown>
  if (record.kind === 'escalate' && Object.keys(record).length === 1) return { kind: 'escalate' }
  if (record.kind !== 'title' || Object.keys(record).length !== 2 || typeof record.title !== 'string') {
    throw new Error('routine thread title had an unknown shape')
  }
  const title = record.title.trim()
  if (!isValidRoutineTitle(title)) throw new Error('routine thread title failed validation')
  return { kind: 'output', value: title }
}

function isValidRoutineTitle(title: string): boolean {
  const words = title.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 6 && title.length <= 80 && !/["']/.test(title) && !/[.!?;:,]$/.test(title)
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
