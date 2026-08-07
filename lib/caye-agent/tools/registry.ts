import type { Tool } from './types'
import { gateHighRisk } from './high-risk-gate'
import { getCalendar } from './read/get-calendar'
import { getHeldQueue } from './read/get-held-queue'
import { getTodaySummary } from './read/get-today-summary'
import { getRevenue } from './read/get-revenue'
import { getTourTypePerformance } from './read/get-tour-type-performance'
import { getCustomer } from './read/get-customer'
import { getCustomerHistory } from './read/get-customer-history'
import { getRecentActivity } from './read/get-recent-activity'
import { getRecentInboundTool } from './read/get-recent-inbound'
import { getRecentBookings } from './read/get-recent-bookings'
import { getPendingQuotes } from './read/get-pending-quotes'
import { searchThreads } from './read/search-threads'
import { queryBusinessKnowledge } from './read/query-business-knowledge'
import { getServices } from './read/get-services'
import { getTeamMembers } from './read/get-team-members'
import { getChannelStatus } from './read/get-channel-status'
import { getConnectLink } from './write-low/get-connect-link'
import { recordChannelIntake } from './write-low/record-channel-intake'
import { markHandled } from './write-low/mark-handled'
import { addBusinessFact } from './write-low/add-business-fact'
import { removeBusinessFact } from './write-low/remove-business-fact'
import { updateServicePrice } from './write-low/update-service-price'
import { addService } from './write-low/add-service'
import { addPricingTier } from './write-low/add-pricing-tier'
import { setServiceVisibility } from './write-low/set-service-visibility'
import { updateBusinessHours } from './write-low/update-business-hours'
import { addBlackoutDate } from './write-low/add-blackout-date'
import { updateVoiceRegister } from './write-low/update-voice-register'
import { addVoiceSample } from './write-low/add-voice-sample'
import { addTeamMember } from './write-low/add-team-member'
import { createOutreachLeads } from './write-low/create-outreach-leads'
import { updateTeamMemberPermissions } from './write-low/update-team-member-permissions'
import { updateTeamMemberName } from './write-low/update-team-member-name'
import { switchWorkspace } from './write-low/switch-workspace'
import { removeTeamMember } from './write-high/remove-team-member'
import { removeService } from './write-high/remove-service'
import { removePricingTier } from './write-high/remove-pricing-tier'
import { removeBlackoutDate } from './write-high/remove-blackout-date'
import { skipHeldItem } from './write-low/skip-held-item'
import { muteCaye } from './write-low/mute-caye'
import { unmuteCaye } from './write-low/unmute-caye'
import { archiveThread } from './write-low/archive-thread'
import { addInternalNote } from './write-low/add-internal-note'
import { sendPaymentConfirmation } from './write-low/send-payment-confirmation'
import { sendReply } from './write-high/send-reply'
import { sendPaymentLink } from './write-high/send-payment-link'
import { confirmBooking } from './write-high/confirm-booking'
import { rescheduleBooking } from './write-high/reschedule-booking'
import { cancelBooking } from './write-high/cancel-booking'
import { sendOutreachBatch } from './write-high/send-outreach-batch'
import { notifyDriver } from './write-low/notify-driver'
import { getMyAssignments } from './read/get-my-assignments'
import { getLogisticsFacts } from './read/get-logistics-facts'
import { escalateDriverQuestion } from './write-low/escalate-driver-question'
import { getCronHealth } from './admin/read/get-cron-health'
import { getWorkspaceAutonomy } from './admin/read/get-workspace-autonomy'
import { triggerCron } from './admin/write-high/trigger-cron'
import { setWorkspaceAutonomy } from './admin/write-high/set-workspace-autonomy'
import { gateAdminHighRisk } from './admin/admin-high-risk-gate'

/**
 * All tools available to the back-office agent.
 *
 * Read tools (11): #38 + #40 — autonomous execution (adds
 * get_channel_status, 2026-08-06 — connect-walkthrough state, derived
 * from connected_accounts rather than stored)
 * Low-risk write tools (21): #37 — autonomous execution (adds
 * remove_business_fact, 2026-07-30 — mirrors add_business_fact so
 * temporary notes like a vacation closure can be retired once stale;
 * update_team_member_name, 2026-07-27 — self-service display name so
 * greetings don't fall back to full_name/legal name; get_connect_link,
 * 2026-08-06 — mints signed channel connect links and hard-refuses
 * WhatsApp when the owner's number is their personal phone, since that
 * migration is destructive and can't be left to prompt text)
 * High-risk write tools (9): #42/#43 — gated through confirmation flow
 * (adds remove_pricing_tier, 2026-07-26; send_outreach_batch, 2026-08-01 —
 * step 3 of the 2026-07-21 staged-autonomy roadmap, batch-approved
 * first-touch outreach sends)
 * Driver-mode tools (4, 2026-07-05): tagged modes: ['driver'] — never
 * shipped to back-office/front-desk requests, see execute.ts mode filter.
 */
type AnyTool = Tool<never>

export const TOOL_REGISTRY: AnyTool[] = [
  // Read
  getCalendar as AnyTool,
  getHeldQueue as AnyTool,
  getTodaySummary as AnyTool,
  getRevenue as AnyTool,
  getTourTypePerformance as AnyTool,
  getCustomer as AnyTool,
  getCustomerHistory as AnyTool,
  getRecentActivity as AnyTool,
  getRecentInboundTool as AnyTool,
  getRecentBookings as AnyTool,
  getPendingQuotes as AnyTool,
  searchThreads as AnyTool,
  queryBusinessKnowledge as AnyTool,
  getServices as AnyTool,
  getTeamMembers as AnyTool,
  getChannelStatus as AnyTool,
  // Low-risk write
  getConnectLink as AnyTool,
  recordChannelIntake as AnyTool,
  markHandled as AnyTool,
  addBusinessFact as AnyTool,
  removeBusinessFact as AnyTool,
  updateServicePrice as AnyTool,
  addService as AnyTool,
  addPricingTier as AnyTool,
  setServiceVisibility as AnyTool,
  updateBusinessHours as AnyTool,
  addBlackoutDate as AnyTool,
  updateVoiceRegister as AnyTool,
  addVoiceSample as AnyTool,
  addTeamMember as AnyTool,
  updateTeamMemberPermissions as AnyTool,
  updateTeamMemberName as AnyTool,
  switchWorkspace as AnyTool,
  skipHeldItem as AnyTool,
  muteCaye as AnyTool,
  unmuteCaye as AnyTool,
  archiveThread as AnyTool,
  addInternalNote as AnyTool,
  sendPaymentConfirmation as AnyTool,
  notifyDriver as AnyTool,
  createOutreachLeads as AnyTool,
  // High-risk write — confirmation flow enforced in code (gateHighRisk,
  // #64), not just the prompt. See lib/caye-agent/tools/high-risk-gate.ts.
  gateHighRisk(sendReply) as AnyTool,
  gateHighRisk(sendPaymentLink) as AnyTool,
  gateHighRisk(confirmBooking) as AnyTool,
  gateHighRisk(rescheduleBooking) as AnyTool,
  gateHighRisk(cancelBooking) as AnyTool,
  gateHighRisk(removeService) as AnyTool,
  gateHighRisk(removePricingTier) as AnyTool,
  gateHighRisk(removeBlackoutDate) as AnyTool,
  gateHighRisk(removeTeamMember) as AnyTool,
  // Batch-approved first-touch outreach sends (2026-08-01) — step 3 of the
  // 2026-07-21 staged-autonomy roadmap. Step 4 (fully autonomous, no
  // review) stays permanently off; this only ever sends threads the
  // operator already reviewed via get_pending_quotes, and only after the
  // same code-enforced confirmation round-trip as every other high-risk
  // tool above.
  gateHighRisk(sendOutreachBatch) as AnyTool,
  // Driver mode
  getMyAssignments as AnyTool,
  getLogisticsFacts as AnyTool,
  escalateDriverQuestion as AnyTool,
  // Admin Shell (2026-07-21) — founder-only dev/ops console, workspace-less.
  // trigger_cron is gated via gateAdminHighRisk (a separate confirmation
  // mechanism from gateHighRisk above, backed by caye_admin_pending_actions
  // rather than caye_pending_actions — see admin-high-risk-gate.ts).
  getCronHealth as AnyTool,
  getWorkspaceAutonomy as AnyTool,
  gateAdminHighRisk(triggerCron) as AnyTool,
  // set_workspace_autonomy is the only way to switch on the opportunity-scan
  // and business-insights crons (both default false in the migration, and
  // nothing in the customer dashboard touches them by design). Gated because
  // enabling a scan points unprompted, recurring WhatsApp traffic at a paying
  // customer's owner — see the tool's own doc comment.
  gateAdminHighRisk(setWorkspaceAutonomy) as AnyTool,
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
