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

/**
 * Detect a bounce / non-delivery notification (NDR). Used by
 * lib/outreach-kill-switch.ts (decisions-log 2026-08-12) as the deliverability
 * signal for the autonomous cold-outreach kill switch — Zoho Mail doesn't
 * expose a dedicated bounce/complaint webhook the way a transactional ESP
 * (Postmark/SendGrid) would, so this subject-pattern classifier is the best
 * available proxy, not a true bounce API. No complaint-rate (spam-report)
 * signal exists at all; this only catches hard/soft bounces, matching the
 * standard NDR subject wording every major mail system uses.
 */
const BOUNCE_SUBJECT_RE =
  /^(?:re:\s*|fwd?:\s*)?(?:undeliverable\b|undeliver(?:able|ed) mail|undelivered mail returned to sender|delivery status notification\s*\(failure\)|delivery (?:has )?failed|mail delivery failed|failure notice|returned mail|message (?:could not be|was not) delivered|delivery (?:incomplete|problem))/i

export function isBounceNotification(subject: string | null | undefined): boolean {
  return !!subject && BOUNCE_SUBJECT_RE.test(subject.trim())
}

/**
 * Hard vs soft classification for a message that has already passed
 * isBounceNotification. Added 2026-09-03 (CAY deliverability incident:
 * bounce rate running 10%+ against an industry danger line of 2-3%, and
 * caye_outreach_bounces couldn't tell a dead mailbox from an out-of-quota
 * one). Body-pattern matching only — same caveat as isBounceNotification:
 * Zoho Mail exposes no bounce API, so this reads the DSN prose a real
 * bounce carries, not a structured code from a provider.
 *
 * hard = the address is dead; never worth retrying (unknown user, no such
 * mailbox, domain not found, 5.x.x-style permanent-failure codes).
 * soft  = transient (mailbox full, over quota, greylisted, deferred,
 * 4.x.x-style codes) — the same address can legitimately succeed later.
 * unknown = classified as a bounce by subject, but the body didn't match
 * either pattern confidently. Treated as the conservative case everywhere
 * it matters (lib/outreach-kill-switch.ts weights it like a hard bounce;
 * lib/outreach-suppression.ts never suppresses on it alone since there's
 * nothing here that identifies which address to blame).
 *
 * Hard is checked before soft: a DSN occasionally repeats the original
 * failed-attempt history, which can include a transient code from an
 * earlier retry alongside the final permanent one. Treating that as hard
 * is the safe direction — a real permanent failure should never be
 * softened into "keep retrying" by noise elsewhere in the body.
 */
export type BounceSeverity = 'hard' | 'soft' | 'unknown'

const HARD_BOUNCE_RE =
  /\b5\.[1-7]\.\d{1,3}\b|\b55[0-9][- ]|\buser unknown\b|\bno such (?:user|recipient|mailbox|address)\b|\bunknown (?:user|recipient)\b|\brecipient (?:address )?rejected\b|\bmailbox (?:unavailable|not found|does not exist)\b|\binvalid (?:recipient|mailbox|address)\b|\baddress (?:not found|rejected|does not exist)\b|\bdomain (?:not found|does not exist)\b|\bhost or domain name not found\b|\bunrouteable address\b|\bpermanent (?:failure|error)\b|\baccount (?:has been )?(?:disabled|closed)\b/i

const SOFT_BOUNCE_RE =
  /\b4\.[0-7]\.\d{1,3}\b|\b4[0-9]{2}[- ]|\bmailbox (?:is )?full\b|\bover quota\b|\bquota exceeded\b|\btemporarily deferred\b|\bdeferred\b|\btry again later\b|\bgreylist(?:ed|ing)?\b|\btemporarily (?:rejected|unavailable|deferred|unable)\b|\bconnection timed out\b|\btemporary (?:failure|error)\b|\bthrottl(?:ed|ing)\b|\brate limit(?:ed)?\b/i

export function classifyBounceSeverity(
  subject: string | null | undefined,
  body: string | null | undefined
): BounceSeverity {
  const text = `${subject ?? ''}\n${body ?? ''}`
  if (HARD_BOUNCE_RE.test(text)) return 'hard'
  if (SOFT_BOUNCE_RE.test(text)) return 'soft'
  return 'unknown'
}

/**
 * Pull the address a DSN reports as failed. Providers vary wildly here, so
 * this tries the standard structured fields first (reliable when present)
 * and falls back to a bounded free-text scan (best-effort, may find
 * nothing). It never guesses past that: a caller that gets `null` back
 * should record the bounce as unattributed rather than pick a plausible-
 * looking address and risk suppressing the wrong lead.
 */
const STRUCTURED_RECIPIENT_RE =
  /(?:final|original)-recipient:\s*(?:rfc822;)?\s*<?([^\s<>]+@[^\s<>]+)>?/i
const X_FAILED_RECIPIENTS_RE = /x-failed-recipients?:\s*<?([^\s<>]+@[^\s<>]+)>?/i
const EMAIL_TOKEN_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const EMAIL_TOKEN_VALID_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i
const NON_RECIPIENT_LOCAL_PARTS_RE = /^(mailer-daemon|postmaster|noreply|no-reply|donotreply)@/i
/** Free-text fallback only looks this far into the body — a DSN's failed
 *  address is always reported near the top; scanning the whole thing risks
 *  picking up an unrelated address quoted further down (e.g. a signature
 *  in the original outbound message the DSN echoes back). */
const RECIPIENT_SCAN_CHAR_LIMIT = 4000

export function extractBouncedRecipient(body: string | null | undefined): string | null {
  if (!body) return null

  const structured = body.match(STRUCTURED_RECIPIENT_RE) ?? body.match(X_FAILED_RECIPIENTS_RE)
  const structuredAddr = structured?.[1]?.trim().toLowerCase()
  if (structuredAddr && EMAIL_TOKEN_VALID_RE.test(structuredAddr)) return structuredAddr

  const snippet = body.slice(0, RECIPIENT_SCAN_CHAR_LIMIT)
  const candidates = snippet.match(EMAIL_TOKEN_RE) ?? []
  const fallback = candidates.find((addr) => !NON_RECIPIENT_LOCAL_PARTS_RE.test(addr))
  return fallback ? fallback.toLowerCase() : null
}

export interface BounceDetail {
  classification: BounceSeverity
  /** Lowercased failed-recipient address, or null when extraction couldn't
   *  confirm one — callers should record "unknown", never guess. */
  recipient: string | null
}

/** Convenience wrapper combining severity + recipient for the one caller
 *  (app/api/email/poll/route.ts) that needs both off one bounce body. */
export function classifyBounceDetail(
  subject: string | null | undefined,
  body: string | null | undefined
): BounceDetail {
  return {
    classification: classifyBounceSeverity(subject, body),
    recipient: extractBouncedRecipient(body),
  }
}
