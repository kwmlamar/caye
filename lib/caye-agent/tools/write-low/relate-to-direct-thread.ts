import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { getOrCreateDirectThread, type ThreadSubjectType } from '@/lib/caye-direct-threads'

const SUBJECT_TYPES: ThreadSubjectType[] = [
  'person',
  'inbox_conversation',
  'booking',
  'lead',
  'escalation',
  'business_fact',
  'work_item',
]

interface RelateToDirectThreadInput {
  subject_type: string
  subject_id: string
  title_hint: string
}

/**
 * Silently associates the CURRENT exchange with a founder-facing Caye
 * Direct thread (2026-08-13) — the mechanism behind "Max discusses Emily,
 * changes topic, comes back to Emily three hours later and Caye still has
 * the thread." Never mentioned to the operator: this is a side effect,
 * not a reply. Call it when the conversation is about something genuinely
 * ongoing/discussable for the founder — a judgment call, same as deciding
 * to escalate or add_business_fact — NOT for routine chatter. Reuses an
 * existing open thread for the same subject when one exists (so a second
 * mention of Emily lands in the same thread instead of spawning a new
 * one); creates one otherwise.
 *
 * Deliberately does NOT link a message row directly — mid-loop, this
 * turn's caye_operator_messages row doesn't exist yet (persisted by the
 * caller after the loop finishes). Instead it records the thread id on
 * ctx.directThreadLinks; the caller links every newly-inserted turn to
 * each requested thread once real ids exist. See ToolContext.directThreadLinks.
 */
export const relateToDirectThread: Tool<RelateToDirectThreadInput> = {
  name: 'relate_to_direct_thread',
  description:
    'Silently connect the current exchange to a topic in Caye Direct (the founder\'s persistent thread history) — never mentioned to the operator. Use when the operator raises something genuinely ongoing that the founder would want to follow as a thread (a pricing exception, an escalation, a recurring question about one lead/customer), not for routine one-off chatter. subject_type + subject_id identify the underlying thing (e.g. subject_type "escalation", subject_id the escalation id from get_held_queue) so a later mention of the same subject reuses the same thread instead of creating a duplicate. title_hint is a short (2-6 word) topic label used only if a new thread is created.',
  risk: 'low',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      subject_type: {
        type: 'string',
        enum: SUBJECT_TYPES,
        description: 'What kind of thing this exchange is about.',
      },
      subject_id: {
        type: 'string',
        description: 'The id of that thing (escalation id, conversation id, contact id, lead id, etc.) — must be a real id from a tool result, never invented.',
      },
      title_hint: {
        type: 'string',
        description: 'Short topic label (2-6 words), e.g. "Emily pricing exception". Only used if this creates a new thread.',
      },
    },
    required: ['subject_type', 'subject_id', 'title_hint'],
  },

  async execute(args, ctx) {
    const subjectId = args.subject_id.trim()
    const titleHint = args.title_hint.trim().slice(0, 80)
    if (!subjectId) return { ok: false, error: 'subject_id is required' }
    if (!SUBJECT_TYPES.includes(args.subject_type as ThreadSubjectType)) {
      return { ok: false, error: `Unknown subject_type "${args.subject_type}"` }
    }

    const supabase = createServiceClient()
    const { thread, reused } = await getOrCreateDirectThread(supabase, {
      workspaceId: ctx.workspaceId,
      subjectType: args.subject_type,
      subjectId,
      titleHint,
      createdBy: 'caye',
    })

    ctx.directThreadLinks?.push(thread.id)

    return { ok: true, data: { thread_id: thread.id, reused } }
  },
}
