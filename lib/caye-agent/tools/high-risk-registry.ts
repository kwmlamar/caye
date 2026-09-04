import type { Tool } from './types'
import { removeTeamMember } from './write-high/remove-team-member'
import { removeService } from './write-high/remove-service'
import { removePricingTier } from './write-high/remove-pricing-tier'
import { removeBlackoutDate } from './write-high/remove-blackout-date'
import { sendReply } from './write-high/send-reply'
import { sendPaymentLink } from './write-high/send-payment-link'
import { confirmBooking } from './write-high/confirm-booking'
import { rescheduleBooking } from './write-high/reschedule-booking'
import { cancelBooking } from './write-high/cancel-booking'
import { sendOutreachBatch } from './write-high/send-outreach-batch'
import { draftInInbox } from './write-high/draft-in-inbox'
import { createCustomerBooking } from './write-high/create-customer-booking'
import { expandOutreachTarget } from './write-high/expand-outreach-target'
import { logCrewDay } from './write-high/log-crew-day'
import { logInvoiceSent } from './write-high/log-invoice-sent'
import { recordPayment } from './write-high/record-payment'
import { logReceipt } from './write-high/log-receipt'

/**
 * The UNGATED high-risk tools, in one place.
 *
 * Two consumers need this list and neither may import the other:
 *   - registry.ts wraps each in gateHighRisk() for the agent's tool list.
 *   - write-high/confirm-pending-action.ts executes the original directly,
 *     using args read back from the staged caye_pending_actions row.
 *
 * Keeping the list here rather than in registry.ts is what breaks the
 * import cycle (registry → confirm_pending_action → registry).
 *
 * A tool must be in this list to be confirmable. That's deliberate: it
 * means confirm_pending_action can never be pointed at something that was
 * never gated in the first place.
 */
type AnyTool = Tool<never>

export const HIGH_RISK_TOOLS: AnyTool[] = [
  logCrewDay as AnyTool,
  logInvoiceSent as AnyTool,
  recordPayment as AnyTool,
  logReceipt as AnyTool,
  sendReply as AnyTool,
  sendPaymentLink as AnyTool,
  confirmBooking as AnyTool,
  rescheduleBooking as AnyTool,
  cancelBooking as AnyTool,
  removeService as AnyTool,
  removePricingTier as AnyTool,
  removeBlackoutDate as AnyTool,
  removeTeamMember as AnyTool,
  // Batch-approved first-touch outreach sends (2026-08-01) — step 3 of the
  // 2026-07-21 staged-autonomy roadmap. Step 4 (fully autonomous, no review)
  // stays permanently off; this only ever sends threads the operator already
  // reviewed via get_pending_quotes, behind the same confirmation round-trip
  // as every other high-risk tool here.
  sendOutreachBatch as AnyTool,
  // Raised from low-risk (2026-08-17, Pam Ott incident) — see
  // write-high/draft-in-inbox.ts's doc comment. Filing something into the
  // operator's own external inbox is reversible for the customer (nothing
  // is sent) but pulls the operator out of the channel they're managing
  // Caye from, so it gets the same confirm-before-it-happens checkpoint as
  // every other consequential action here.
  draftInInbox as AnyTool,
  createCustomerBooking as AnyTool,
  expandOutreachTarget as AnyTool,
]

export function findHighRiskTool(name: string): AnyTool | undefined {
  return HIGH_RISK_TOOLS.find((t) => t.name === name)
}
