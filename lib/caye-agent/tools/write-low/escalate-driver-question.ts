import 'server-only'
import { randomUUID } from 'crypto'
import { enqueueEscalationPings } from '@/lib/whatsapp/triggers'
import type { Tool } from '../types'

interface EscalateDriverQuestionInput {
  question: string
}

/**
 * Driver-mode's only write tool (2026-07-05). Fires when a driver asks
 * something outside get_my_assignments / get_logistics_facts scope —
 * pricing, special requests, anything Caye genuinely doesn't have. Pings
 * the owner directly rather than leaving the driver without a next step.
 *
 * Unlike guest-facing escalations (recordEscalation), there's no
 * unified_conversations row for a driver thread, so this calls
 * enqueueEscalationPings directly instead of going through
 * lib/whatsapp/escalation.ts.
 */
export const escalateDriverQuestion: Tool<EscalateDriverQuestionInput> = {
  name: 'escalate_to_owner',
  description:
    'Ping the business owner when a driver asks something you can\'t answer from ' +
    'get_my_assignments or get_logistics_facts — pricing, a special request, anything outside ' +
    'plain pickup logistics. Tell the driver you\'re checking with the owner before calling this.',
  risk: 'low',
  roles: ['driver'],
  modes: ['driver'],
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The driver\'s question, verbatim or lightly summarized.',
      },
    },
    required: ['question'],
  },

  async execute(args, ctx) {
    const question = args.question.trim()
    if (question.length < 3) return { ok: false, error: 'Question is too short to escalate.' }

    await enqueueEscalationPings({
      workspaceId: ctx.workspaceId,
      escalationId: randomUUID(),
      conversationId: null,
      contactName: 'Driver',
      category: 'driver_question',
      routeTo: 'owner',
      suggestedReply: '',
      internalContext: `Driver asked: "${question}"`,
      pingSummary: question.slice(0, 100),
    })

    return { ok: true, data: { escalated: true } }
  },
}
