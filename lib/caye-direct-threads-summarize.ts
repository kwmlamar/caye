import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createRoutineInferenceLogger, runInference, type RoutineParseResult } from '@/lib/routine-inference'
import { loggedMessagesCreate } from '@/lib/llm-telemetry'
import { getThread, getThreadMessages, type ThreadMessageRow } from '@/lib/caye-direct-threads'
import { isInternalTurnBody, visibleBody } from '@/lib/caye-operator-messages'

const SUMMARY_TRIGGER_MESSAGE_COUNT = 20
const TITLE_WORKLOAD = 'caye_direct_thread_title'

const FRONTIER_TITLE_SYSTEM =
  'You title a short conversation snippet in 2-6 words. Describe the SUBJECT, not the fact that it\'s a conversation. No punctuation at the end, no quotes, no "Conversation about". Examples: "Emily pricing exception", "August bookings", "Deposit policy". Reply with the title only.'

const ROUTINE_TITLE_SYSTEM =
  'Classify a founder-only conversation snippet into a sidebar title. Return ONLY JSON matching exactly {"kind":"title","title":"2-6 word subject"} or {"kind":"escalate"}. Use escalate when the subject is ambiguous. A title must be 2-6 plain words, at most 80 characters, without quotes or ending punctuation. It is display-only and must describe the subject, not that this is a conversation.'

async function generateWithGateway(args: {
  workspaceId: string
  system: string
  input: string
  maxOutputTokens: number
  source: string
}): Promise<string> {
  const response = await loggedMessagesCreate(
    null,
    {
      model: 'auto',
      system: args.system,
      max_tokens: args.maxOutputTokens,
      messages: [{ role: 'user', content: args.input }],
    },
    { source: args.source, task: 'summarization', workspaceId: args.workspaceId }
  )
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.type === 'text' ? block.text : '')
    .join('\n')
    .trim()
  if (!text) throw new Error('AI gateway returned no text')
  return text
}

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

export async function maybeGenerateThreadTitle(workspaceId: string, threadId: string): Promise<void> {
  const supabase = createServiceClient()
  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread || thread.title) return
  const rows = await getThreadMessages(supabase, threadId, 40)
  const transcript = completedTitleTranscript(rows)
  if (!transcript) return

  try {
    const title = await runInference({
      tier: 'routine',
      frontierModel: 'auto',
      frontier: () => generateThreadTitleWithGateway(workspaceId, transcript),
      routine: {
        system: ROUTINE_TITLE_SYSTEM,
        messages: [{ role: 'user', content: transcript }],
        maxOutputTokens: 60,
        parse: parseRoutineThreadTitle,
      },
      onMetadata: createRoutineInferenceLogger(TITLE_WORKLOAD),
    })
    if (title) {
      await supabase.from('caye_direct_threads')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', threadId)
        .is('title', null)
    }
  } catch (err) {
    console.warn('[caye-direct-threads-summarize] title generation failed:', err)
  }
}

async function generateThreadTitleWithGateway(workspaceId: string, transcript: string): Promise<string | null> {
  const text = await generateWithGateway({
    workspaceId,
    system: FRONTIER_TITLE_SYSTEM,
    input: transcript,
    maxOutputTokens: 512,
    source: 'lib/caye-direct-threads-summarize.ts:title',
  })
  return text.replace(/^["']|["']$/g, '').trim().slice(0, 80) || null
}

export function parseRoutineThreadTitle(content: string): RoutineParseResult<string | null> {
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error('routine thread title was not JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('routine thread title was not an object')
  const parsed = value as Record<string, unknown>
  if (parsed.kind === 'escalate' && Object.keys(parsed).length === 1) return { kind: 'escalate' }
  if (parsed.kind !== 'title' || Object.keys(parsed).length !== 2 || typeof parsed.title !== 'string') {
    throw new Error('routine thread title had an unknown shape')
  }
  const title = parsed.title.trim()
  if (!isValidRoutineTitle(title)) throw new Error('routine thread title failed validation')
  return { kind: 'output', value: title }
}

function isValidRoutineTitle(title: string): boolean {
  const words = title.split(/\s+/).filter(Boolean)
  return words.length >= 2 && words.length <= 6 && title.length <= 80 && !/["']/.test(title) && !/[.!?;:,]$/.test(title)
}

export async function maybeRefreshThreadSummary(workspaceId: string, threadId: string): Promise<void> {
  const supabase = createServiceClient()
  const thread = await getThread(supabase, workspaceId, threadId)
  if (!thread) return
  const rows = await getThreadMessages(supabase, threadId, 500)
  const visible = rows.filter((r) => !isInternalTurnBody(r.body))
  if (visible.length < SUMMARY_TRIGGER_MESSAGE_COUNT) return
  if (thread.summary_updated_at) {
    const sinceLastSummary = visible.filter((r) => r.created_at > thread.summary_updated_at!).length
    if (sinceLastSummary < SUMMARY_TRIGGER_MESSAGE_COUNT) return
  }

  const transcript = visible
    .map((r) => `${r.direction === 'inbound' ? (r.operator_name ?? 'Operator') : 'Caye'}: ${visibleBody(r.body)}`)
    .join('\n')
    .slice(0, 12000)

  try {
    const summary = await generateWithGateway({
      workspaceId,
      system: 'Condense this conversation thread into a compact briefing for someone resuming it later. Cover: current topic/objective, important facts, decisions made, unresolved questions, actions taken or planned. 3-6 short sentences, plain prose, no headers or bullet points. This is a working summary, not a transcript. Omit pleasantries and small talk.',
      input: transcript,
      maxOutputTokens: 800,
      source: 'lib/caye-direct-threads-summarize.ts:summary',
    })
    if (summary) {
      await supabase.from('caye_direct_threads')
        .update({ summary, summary_updated_at: new Date().toISOString() })
        .eq('id', threadId)
    }
  } catch (err) {
    console.warn('[caye-direct-threads-summarize] summary refresh failed:', err)
  }
}
