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

/**
 * Detect out-of-office / vacation-responder auto-replies. These come from
 * real human senders (isNoReplySender misses them — the OOO tool sends
 * from the person's own address) but they're pure noise: a bounce back
 * from a business you emailed, not a conversation. Auto-archived same as
 * isNoReplySender/isCalendarInvite.
 *
 * Added for issue #66 (TropiTech's own cold-outreach reply inbox,
 * ~100+/day outbound) where OOO volume would otherwise flood the founder's
 * review queue with nothing to act on, but the check applies globally —
 * OOO noise isn't useful signal for any workspace.
 *
 * Detection: common subject prefixes ("Automatic reply:", "Out of Office:",
 * "Away from my desk", "Auto-Reply:", "Autoresponder:") or body phrases
 * typical of vacation-responder templates ("I am currently out of the
 * office", "I will be out of office", "I am away from my desk").
 */

const OUT_OF_OFFICE_SUBJECT_RE =
  /^(?:re:\s*|fwd?:\s*)?(?:automatic reply|auto[\s-]?reply|autoresponder|out of office|away from (?:my|the) (?:desk|office))\s*[:\-]?/i

const OUT_OF_OFFICE_BODY_RE =
  /\b(?:i(?:'m| am) currently out of the office|i(?:'m| am) out of the office|i will be out of (?:the )?office|i(?:'m| am) away from (?:my|the) desk|i(?:'m| am) on (?:vacation|leave|pto)\b.{0,40}\b(?:limited|no) access to email|thank you for your email\.? i am (?:currently )?(?:out of|away))\b/i

export function isOutOfOffice(subject: string | null | undefined, body: string | null | undefined): boolean {
  if (subject && OUT_OF_OFFICE_SUBJECT_RE.test(subject.trim())) return true
  if (body && OUT_OF_OFFICE_BODY_RE.test(body)) return true
  return false
}

/**
 * Detect ChargeAnywhere-style payment processor receipts. Sender is
 * typically `noreply@chargeanywhere.com` (already caught by isNoReplySender)
 * but the subject is generic ("Receipt", "Settlement Details for MM/DD/YY",
 * "Payment Attempt Not Completed") and the body has a labeled-fields
 * shape with Response / ApprovalCode / Customer Name.
 *
 * Used by the webhook to skip receipt emails entirely — the cron poll
 * has the full receipt handling path (parse + match to pending booking +
 * send thank-you). Webhook just gets out of the way.
 *
 * Mirrors the in-poll detector at app/api/email/poll/route.ts so both
 * paths agree on what "looks like a receipt" means.
 */
export function isPaymentReceipt(subject: string | null | undefined, body: string | null | undefined): boolean {
  if (subject && /RECEIPT PAGE/i.test(subject)) return true
  if (!body) return false
  return (
    /^\s*Response:/im.test(body) &&
    /^\s*ApprovalCode:/im.test(body) &&
    /^\s*Customer Name:/im.test(body)
  )
}
