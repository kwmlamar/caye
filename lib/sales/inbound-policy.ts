import { findEscalationTriggers, customerFacingHandoff } from './escalation-triggers'
import { isBounceNotification, isOutOfOffice } from '@/lib/sender-classifier'
import { classifySalesReplyIntent } from './reply-intent'

export type SalesInboundKind = 'human_reply' | 'automated_ooo' | 'opt_out' | 'bounce_or_delivery_failure' | 'unknown'

export type SalesInboundPolicy =
  | { kind: 'human_reply' }
  | { kind: 'automated_ooo' }
  | { kind: 'opt_out' }
  | { kind: 'bounce_or_delivery_failure' }
  | { kind: 'internal' }
  | { kind: 'deterministic_escalation'; message: string; reason: string }
  | { kind: 'unknown'; reason: string }

const OPT_OUT_RE = /\b(?:unsubscribe|remove me|take me off|do not contact|don't contact|stop emailing|stop contacting)\b/i

/** Pure, cheap and deliberately conservative. Model dispatch is only for a human reply. */
export function decideSalesInboundPolicy(
  subject: string | null | undefined,
  body: string | null | undefined,
  context: { senderEmail?: string | null; workspaceEmail?: string | null; synthetic?: boolean } = {},
): SalesInboundPolicy {
  const text = `${subject ?? ''}\n${body ?? ''}`.trim()
  if (context.synthetic) return { kind: 'internal' }
  if (context.senderEmail && context.workspaceEmail &&
      context.senderEmail.trim().toLowerCase() === context.workspaceEmail.trim().toLowerCase()) {
    return { kind: 'internal' }
  }
  if (isBounceNotification(subject)) return { kind: 'bounce_or_delivery_failure' }
  if (isOutOfOffice(subject, body)) return { kind: 'automated_ooo' }
  if (OPT_OUT_RE.test(text)) return { kind: 'opt_out' }
  const intent = classifySalesReplyIntent(body)
  if (intent.nextAction === 'ESCALATE') return {
    kind: 'deterministic_escalation',
    message: intent.intent === 'human_requested'
      ? 'Of course — I’ll get Lamar involved.'
      : intent.intent === 'pricing_exception'
        ? 'I can share the standard price, but Lamar handles exceptions. I’ll get him involved.'
      : 'I can’t make that commitment, but I’ll get Lamar to follow up.',
    reason: intent.intent,
  }
  const [trigger] = findEscalationTriggers(text)
  if (trigger) return {
    kind: 'deterministic_escalation', message: customerFacingHandoff(trigger.category),
    reason: `${trigger.why} (matched "${trigger.phrase}")`,
  }
  if (!text) return { kind: 'unknown', reason: 'Empty inbound sales message' }
  return { kind: 'human_reply' }
}
