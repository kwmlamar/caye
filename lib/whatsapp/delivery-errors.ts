import 'server-only'

/**
 * Classifies a Meta WhatsApp Cloud API error code so callers can react
 * differently instead of treating every failure as "retry and hope":
 *
 *   - account_fatal: the whole WABA is down (billing, disabled account).
 *     Every workspace is affected. Alert once, globally — don't retry.
 *   - window_or_template: Caye's own bug (24h window closed, bad template
 *     params). Auto-remediable by falling back to a template send.
 *   - recipient_unreachable: this one phone number specifically (blocked,
 *     opted out, invalid). Mark that workspace unreachable; don't alert
 *     the founder about every workspace.
 *   - transient: everything else — normal retry path.
 *
 * Confirmed live 2026-07-27: 93 operator pings over 14 days produced zero
 * confirmed deliveries. The first 90 were undetectable (wa_message_id
 * wasn't persisted, so status callbacks never matched a row). The moment
 * correlation started working, 3/3 sends failed with 131042 (WABA payment
 * eligibility) and 131047 (24h window closed) — and nothing alerted,
 * because the operator-facing webhook never called the founder-alert path
 * at all. See briefs/whatsapp-delivery-reliability.md.
 */
export type DeliveryFailureClass =
  | 'account_fatal'
  | 'window_or_template'
  | 'recipient_unreachable'
  | 'transient'

export function classifyDeliveryError(code: number | null | undefined): DeliveryFailureClass {
  if (code == null) return 'transient'
  // 131042: business eligibility payment issue. 131031: account restricted.
  // 133xxx: account/setup-level errors (hub down, permission revoked, etc).
  if (code === 131042 || code === 131031) return 'account_fatal'
  if (code >= 133000 && code < 134000) return 'account_fatal'
  // 131047: re-engagement / 24h window closed. 132xxx: template errors
  // (missing, param mismatch, not approved).
  if (code === 131047) return 'window_or_template'
  if (code >= 132000 && code < 133000) return 'window_or_template'
  // 131026: undeliverable. 131048: spam rate limit / opted out.
  // 368: temporarily blocked for policy violations. 470: re-engagement
  // (older API version's code for the same condition as 131047 — grouped
  // here defensively in case an older callback shape ever surfaces it).
  if (code === 131026 || code === 131048 || code === 368 || code === 470) {
    return 'recipient_unreachable'
  }
  return 'transient'
}

/**
 * Best-effort extraction of Meta's numeric error code from either shape we
 * store it in: the delivery-status webhook's formatted "131042: message"
 * string (see handleDeliveryStatus), or the dispatch-time SendResult error
 * string ("meta http 400 code 131042: message", see lib/whatsapp/outbound.ts).
 */
export function extractErrorCode(detail: string | null | undefined): number | null {
  if (!detail) return null
  const match = detail.match(/^(\d{3,6}):/) ?? detail.match(/code (\d{3,6})/)
  const code = match ? Number(match[1]) : NaN
  return Number.isFinite(code) ? code : null
}
