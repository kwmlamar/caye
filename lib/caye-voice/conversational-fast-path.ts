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
  const normalized = normalizeSpokenPunctuation(text)
    .toLowerCase()
    .replace(/\b(key|kay)\b/g, 'caye')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/^(hi|hey|hello|yo|sup|wassup)( caye)?$/.test(normalized)) return "Hey. I'm here. What's up?"
  if (/^(hi|hey|hello|yo)( caye)? (what'?s up|how are you|you there)$/.test(normalized)) return "I'm here. What's up?"
  if (/^(hi|hey|hello|yo) (what'?s up|how are you|you there) caye$/.test(normalized)) return "I'm here. What's up?"
  if (/^(what'?s up)( caye)?$/.test(normalized)) return "I'm here. What's up?"
  if (/^(can you hear me|do you hear me)( caye)?$/.test(normalized)) return 'Yep, I can hear you.'
  if (/^(are you there|you there)( caye)?$/.test(normalized)) return "Yep. I'm here."
  if (/^(thanks|thank you|appreciate it)( caye)?$/.test(normalized)) return 'Anytime.'
  if (/^(cool|okay|ok|got it)( caye)?$/.test(normalized)) return 'Got you.'

  return null
}

const fastPathWriteQueues = new Map<string, Promise<void>>()

function queuePerThread(threadId: string, work: () => Promise<void>): Promise<void> {
  const previous = fastPathWriteQueues.get(threadId) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tail = next.catch(() => {})
  fastPathWriteQueues.set(threadId, tail)
  void tail.then(() => {
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
