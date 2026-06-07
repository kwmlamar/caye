/**
 * sender-classifier.ts
 *
 * Pure email-sender classification helpers. Used by inbound polling routes to
 * decide:
 *
 *   - isNoReplySender: should this inbound auto-archive the conversation it
 *     creates? (vendor/automation/system addresses — noreply@, mailer-daemon@,
 *     calendar-notifications@, etc.) Saved for audit, hidden from default
 *     inbox view.
 *
 * Note: the "should we auto-reply?" gate in the Zoho poll path uses a wider
 * regex that also catches role addresses like info@, support@, admin@. Those
 * are legitimate sender addresses from real prospects (small businesses often
 * email from their generic inbox) and shouldn't be auto-archived, but Caye
 * also shouldn't auto-reply to them. The two gates intentionally differ.
 */

const NO_REPLY_LOCAL_PART_RE =
  /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|system)$/i

const NO_REPLY_DOMAIN_KEYWORDS = ['mailer-daemon', 'postmaster']

export function isNoReplySender(email: string | null | undefined): boolean {
  if (!email) return false
  const lower = email.toLowerCase().trim()
  const localPart = lower.split('@')[0] || ''
  if (NO_REPLY_LOCAL_PART_RE.test(localPart)) return true
  if (NO_REPLY_DOMAIN_KEYWORDS.some(k => lower.includes(k))) return true
  return false
}

/**
 * Detect Google Calendar / Outlook / iCal meeting invitations and
 * cancellations. These come from real human senders (so isNoReplySender
 * misses them) but they're not customer conversations — they're calendar
 * notifications that should auto-archive same as noreply.
 *
 * Background: Valeriia Berezhna 2026-05-21 case landed 4 calendar-invite
 * conversations from her personal address (valeriia@accessibletravelsolutions.com).
 * Her real partnership thread is captured separately under a different
 * Caye conversation. The invites clutter the inbox without adding signal.
 *
 * Detection: any of
 *   - Subject begins with "Invitation:" / "Updated invitation:" /
 *     "Cancelled event:" / "Accepted:" / "Declined:" / "Tentative:"
 *   - Body contains a VCALENDAR block (the iCal MIME payload that
 *     calendar clients embed in the visible body when the email is
 *     downgraded to plaintext)
 */

const CALENDAR_INVITE_SUBJECT_RE =
  /^(?:re:\s*|fwd?:\s*)?(?:invitation|updated invitation|cancell?ed(?:\s+event)?|accepted|declined|tentatively\s+accepted|tentative):/i

const VCALENDAR_BODY_RE = /BEGIN:VCALENDAR\b/i

export function isCalendarInvite(subject: string | null | undefined, body: string | null | undefined): boolean {
  if (subject && CALENDAR_INVITE_SUBJECT_RE.test(subject.trim())) return true
  if (body && VCALENDAR_BODY_RE.test(body)) return true
  return false
}
