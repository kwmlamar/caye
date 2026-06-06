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
