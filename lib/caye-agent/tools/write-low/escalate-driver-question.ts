import 'server-only'
import { randomUUID } from 'crypto'
import { createHash } from 'crypto'
import { enqueueEscalationPings } from '@/lib/whatsapp/triggers'
import { decideOperatorNotification, recordOperatorNotified } from '@/lib/whatsapp/operator-notification-gate'
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

    // No unified_conversations row exists for a driver thread (see the
    // module comment), so this can't reuse recordEscalation's conversation-
    // scoped dedupe. Give it its own stable key instead — same driver +
    // near-identical question shouldn't re-ping every time the driver
    // repeats themselves or the model retries. Normalized (lowercased,
    // whitespace-collapsed, truncated) so trivial rephrasing still collapses
    // — deliberately cheap text normalization, not semantic classification.
    const normalizedQuestion = question.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
    const driverKey = ctx.operatorId != null ? String(ctx.operatorId) : ctx.callerPhone ?? 'unknown-driver'
    const subjectId = createHash('sha256').update(`${driverKey}:${normalizedQuestion}`).digest('hex').slice(0, 32)

    const decision = await decideOperatorNotification({
      workspaceId: ctx.workspaceId,
      subjectType: 'driver_question',
      subjectId,
      title: `Driver — ${question.slice(0, 80)}`,
      priority: 'decision',
      fingerprintParts: [normalizedQuestion],
      blockedOnOperator: true,
      resolvableAutonomously: false,
    })

    if (decision.outcome === 'SUPPRESS_NO_CHANGE' || decision.outcome === 'SUPPRESS_RECENTLY_NOTIFIED') {
      // Already told the owner about this exact question recently — the
      // driver still gets told Caye is checking, just without a second ping.
      return { ok: true, data: { escalated: false, alreadyNotified: true } }
    }

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

    // enqueueEscalationPings' rows carry a fresh escalationId, not this
    // tool's driver_question subjectId, so outbound-worker's generic
    // escalation-kind stamping (keyed by conversationId-or-escalationId)
    // can't find this item to mark it notified. Stamp it directly here
    // instead — narrow, self-contained tool, enqueue failing after this
    // point just means one redundant future ping, never a lost one.
    await recordOperatorNotified({
      workspaceId: ctx.workspaceId,
      subjectType: 'driver_question',
      subjectId,
      summary: question.slice(0, 200),
    })

    return { ok: true, data: { escalated: true } }
  },
}
