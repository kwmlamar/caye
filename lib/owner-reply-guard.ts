/**
 * Prevent a reply race without turning ordinary owner activity into a
 * conversation takeover.
 *
 * A manual business message only suppresses Caye for the customer message it
 * answered (or an earlier one still being processed). A later customer reply
 * is a fresh turn: Caye must evaluate it normally unless a real hold is open.
 */
export interface LastBusinessMessage {
  sentAt: string
  senderAttribution?: string | null
  metadata?: unknown
}

export function isManualOwnerMessage(message: LastBusinessMessage): boolean {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>
  return (
    message.senderAttribution === 'human_via_external' ||
    message.senderAttribution === 'human_via_caye' ||
    metadata.sent_by === 'human' ||
    metadata.source === 'zoho_sent'
  )
}

/** True only when the owner has already answered this inbound turn. */
export function ownerAlreadyAnsweredInbound(
  lastBusinessMessage: LastBusinessMessage | null | undefined,
  inboundSentAt: string
): boolean {
  if (!lastBusinessMessage || !isManualOwnerMessage(lastBusinessMessage)) return false
  const ownerReplyAt = new Date(lastBusinessMessage.sentAt).getTime()
  const inboundAt = new Date(inboundSentAt).getTime()
  return Number.isFinite(ownerReplyAt) && Number.isFinite(inboundAt) && ownerReplyAt >= inboundAt
}

/**
 * Conservative scoped acknowledgement for an externally-sent owner reply.
 * We only clear a hold when the reply shares two meaningful terms with the
 * hold's reason or Caye's proposed reply. This deliberately prefers one
 * extra reminder to silently clearing an unrelated pricing/policy decision.
 */
export function ownerReplyAddressesHold(ownerReply: string, evidence: Array<string | null | undefined>): boolean {
  const terms = (text: string) =>
    new Set(
      (text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(word => !COMMON_TERMS.has(word))
    )
  const replyTerms = terms(ownerReply)
  if (replyTerms.size === 0) return false
  const evidenceTerms = new Set(evidence.flatMap(text => [...terms(text ?? '')]))
  let matches = 0
  for (const term of replyTerms) {
    if (evidenceTerms.has(term) && ++matches >= 2) return true
  }
  return false
}

const COMMON_TERMS = new Set([
  'thank', 'thanks', 'there', 'would', 'could', 'should', 'please', 'hello',
  'regards', 'response', 'understand', 'coordinate', 'accordingly', 'with',
])
