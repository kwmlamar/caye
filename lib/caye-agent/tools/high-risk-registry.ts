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
 *
 * `draft_in_inbox` is deliberately NOT registered. As of 2026-08-18 the
 * product rule is simpler: owner/operator drafting always happens inside the
 * active Caye conversation. Caye must never redirect an owner to Gmail, Zoho,
 * or any other mailbox Drafts folder. Historical pending draft_in_inbox rows
 * are retired safely inside confirm_pending_action rather than executed.
 */
type AnyTool = Tool<never>

export const HIGH_RISK_TOOLS: AnyTool[] = [
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
]

export function findHighRiskTool(name: string): AnyTool | undefined {
  return HIGH_RISK_TOOLS.find((t) => t.name === name)
}
