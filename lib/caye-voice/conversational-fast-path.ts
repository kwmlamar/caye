import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { getThread, setThreadStatus, touchThread, linkInsertedMessagesToThreads } from '@/lib/caye-direct-threads'
import { maybeGenerateThreadTitle, maybeRefreshThreadSummary } from '@/lib/caye-direct-threads-summarize'
import { normalizeSpokenPunctuation } from './spoken-text'

/**
 * Narrow deterministic lane for voice turns that cannot require business state,
 * tools, memory lookup, approvals, or side effects. Everything else returns
 * null and must use the normal founder control plane.
 */
export function conversationalVoiceReply(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  // normalizeSpokenPunctuation FIRST: the `[^a-z0-9'\s]` scrub below turns
  // any character it doesn't recognise into a space, so a typographic
  // apostrophe used to split "what's" into "what s" and miss every pattern
  // here. See spoken-text.ts for the measured before/after.
  const normalized = normalizeSpokenPunctuation(text)
    .toLowerCase()
    .replace(/\b(key|kay)\b/g, 'caye')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/^(hi|hey|hello|yo|sup|wassup)( caye)?$/.test(normalized)) return "Hey. I'm here. What's up?"
  if (/^(hi|hey|hello|yo)( caye)? (what'?s up|how are you|you there)$/.test(normalized)) return "I'm here. What's up?"
  if (/^(what'?s up)( caye)?$/.test(normalized)) return "I'm here. What's up?"
  if (/^(can you hear me|do you hear me)( caye)?$/.test(normalized)) return 'Yep, I can hear you.'
  if (/^(are you there|you there)( caye)?$/.test(normalized)) return "Yep. I'm here."
  if (/^(thanks|thank you|appreciate it)( caye)?$/.test(normalized)) return 'Anytime.'
  if (/^(cool|okay|ok|got it)( caye)?$/.test(normalized)) return 'Got you.'

  return null
}

/**
 * Serializes fast-lane writes per thread.
 *
 * The voice route replies BEFORE this write completes (see its after()
 * block) so the founder isn't waiting on a database round trip to hear an
 * answer Caye already knew. That trade is only safe if two quick
 * back-to-back fast-path turns can't land out of order — "Hey Caye" /
 * "thanks" spoken a second apart would otherwise race, and the thread
 * transcript would read backwards. Each thread's writes therefore queue
 * behind the previous one.
 *
 * In-process only, which is exactly the scope of the race it fixes: the
 * two turns at risk are milliseconds apart on one warm instance. Nothing
 * here is a distributed lock and it isn't trying to be.
 */
const fastPathWriteQueues = new Map<string, Promise<void>>()

function queuePerThread(threadId: string, work: () => Promise<void>): Promise<void> {
  const previous = fastPathWriteQueues.get(threadId) ?? Promise.resolve()
  // Runs on both settlement paths: one failed write must not wedge every
  // later turn on this thread.
  const next = previous.then(work, work)
  // The map holds a never-rejecting handle so an unawaited failure here is
  // never an unhandled rejection; the caller still gets the real `next`.
  const tail = next.catch(() => {})
  fastPathWriteQueues.set(threadId, tail)
  void tail.then(() => {
    // Drop the entry only when nothing newer queued behind us, so the map
    // doesn't grow one entry per thread for the life of the instance.
    if (fastPathWriteQueues.get(threadId) === tail) fastPathWriteQueues.delete(threadId)
  })
  return next
}

/** Persist a fast-lane exchange into the exact durable founder thread history. */
export async function persistConversationalVoiceTurn(
  workspaceId: string,
  threadId: string,
  message: string,
  replyText: string
): Promise<void> {
  return queuePerThread(threadId, () => writeConversationalVoiceTurn(workspaceId, threadId, message, replyText))
}

async function writeConversationalVoiceTurn(
  workspaceId: string,
  threadId: string,
  message: string,
  replyText: string
): Promise<void> {
  const supabase = createServiceClient()
  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread) throw new Error('Thread not found')
  if (thread.status === 'archived') await setThreadStatus(supabase, workspaceId, threadId, 'active')

  const operator = await resolveFounderOperator(supabase, workspaceId)
  const turns: Anthropic.MessageParam[] = [
    { role: 'user', content: message.trim() },
    { role: 'assistant', content: replyText },
  ]
  const inserted = await persistAgentTurns(
    supabase,
    workspaceId,
    turns,
    operator,
    undefined,
    undefined,
    'dashboard',
    'visible'
  )
  if (inserted.length !== 2) throw new Error('Could not persist conversational voice turn')
  const ids = inserted.map((row) => row.id)
  await linkInsertedMessagesToThreads(supabase, ids, [threadId])
  await touchThread(supabase, threadId)
  await maybeGenerateThreadTitle(workspaceId, threadId)
  void maybeRefreshThreadSummary(workspaceId, threadId).catch(() => {})
}
