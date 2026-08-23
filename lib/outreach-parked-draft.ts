import { isQueueHold, holdKindOf } from './hold-kinds-shared'

export type ParkedOutreachAction = 'send_first_touch' | 'send_followup'

export interface RevalidatableParkedDraft {
  body: string
  subject: string | null
}

/**
 * Returns an existing outreach queue draft only when it is safe for the
 * autosend scan to revalidate it. A generic held conversation remains an
 * owner-owned hold; an unanswered reply always wins over scheduled outreach.
 *
 * Queue drafts are not sent merely because they exist. The caller must still
 * run the current lead-state, content, authority, pause, cap, and claim
 * checks before dispatching this exact body.
 */
export function getRevalidatableParkedDraft(input: {
  humanAgentEnabled: boolean | null | undefined
  metadata: unknown
  hasUnansweredReply: boolean
  action: ParkedOutreachAction
}): RevalidatableParkedDraft | null {
  if (!input.humanAgentEnabled || input.hasUnansweredReply) return null

  const metadata = input.metadata && typeof input.metadata === 'object'
    ? input.metadata as Record<string, unknown>
    : null
  if (!metadata) return null

  const holdKind = holdKindOf(metadata)
  const expectedKind = input.action === 'send_first_touch'
    ? 'outreach_first_touch'
    : 'outreach_followup'
  if (holdKind !== expectedKind || !isQueueHold(holdKind)) return null

  const body = typeof metadata.proposed_reply === 'string' ? metadata.proposed_reply.trim() : ''
  if (!body) return null

  return {
    body,
    subject: typeof metadata.subject === 'string' && metadata.subject.trim()
      ? metadata.subject.trim()
      : null,
  }
}
