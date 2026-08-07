/**
 * Who actually wrote an outbound message.
 *
 * `metadata.sent_by` already records who *dispatched* a message ('human' when
 * it went out through the dashboard). That is not the same question as who
 * *composed* it, and conflating the two is why 364 of 504 outbound messages
 * are unattributable: batch-approved cold outreach is drafted by Caye and
 * clicked by a person, so it lands as sent_by='human' with no trace that the
 * words were hers. On the TropiTech Outreach workspace that is 158 messages
 * asserting a human hand-typed them.
 *
 * The distinction matters beyond bookkeeping. "Did Caye handle this thread?"
 * and "does Caye's draft survive contact with the owner?" are both authorship
 * questions, and the second is the only accuracy signal the product has —
 * a draft the owner rewrites before sending is a graded wrong answer.
 *
 * Returned fields:
 *   authored_by  — 'caye' | 'human' | 'human_edited'
 *   generated_by — set to 'caye' only when the text is Caye's, unedited.
 *                  Kept because existing readers key off it
 *                  (activity-since.ts, owner-voice-learning.ts, health).
 *
 * 'human_edited' is deliberately distinct from 'human': the owner started
 * from Caye's draft and changed it. Counting those as pure human sends hides
 * the correction rate; counting them as Caye's would credit her with words
 * she got wrong.
 */

export type AuthoredBy = 'caye' | 'human' | 'human_edited'

export interface Authorship {
  authored_by: AuthoredBy
  generated_by?: 'caye'
}

/**
 * Whitespace-insensitive comparison. Editors and mail clients reflow drafts —
 * a trailing newline or a collapsed double space is not a human rewrite, and
 * treating it as one would inflate the correction rate with noise.
 */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function classifyOutboundAuthorship(
  sentText: string,
  proposedReply: unknown
): Authorship {
  const draft = typeof proposedReply === 'string' ? proposedReply : ''

  // No draft on the thread — nobody but the sender wrote this.
  if (!draft.trim()) {
    return { authored_by: 'human' }
  }

  if (normalize(draft) === normalize(sentText)) {
    return { authored_by: 'caye', generated_by: 'caye' }
  }

  return { authored_by: 'human_edited' }
}
