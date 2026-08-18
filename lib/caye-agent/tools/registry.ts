import type { Tool } from './types'
import { gateHighRisk } from './high-risk-gate'
import { gateExternalDraftIntent } from './external-draft-intent-gate'
import { HIGH_RISK_TOOLS } from './high-risk-registry'
import { confirmPendingAction } from './write-high/confirm-pending-action'
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
import { listStandingRules } from './read/list-standing-rules'
import { getServices } from './read/get-services'
import { getTeamMembers } from './read/get-team-members'
import { getChannelStatus } from './read/get-channel-status'
import { getOutreachStatus } from './read/get-outreach-operational-status'
import { getConnectLink } from './write-low/get-connect-link'
import { recordChannelIntake } from './write-low/record-channel-intake'
import { markHandled } from './write-low/mark-handled'
import { scheduleReminder } from './write-low/schedule-reminder'
import { sendOperatorMessage } from './write-low/send-operator-message'
import { addServiceAvailabilityRule } from './write-low/add-service-availability-rule'
import { addBusinessFact } from './write-low/add-business-fact'
import { confirmFactCandidate } from './write-low/confirm-fact-candidate'
import { dismissFactCandidate } from './write-low/dismiss-fact-candidate'
import { removeBusinessFact } from './write-low/remove-business-fact'
import { addStandingRule } from './write-low/add-standing-rule'
import { removeStandingRule } from './write-low/remove-standing-rule'
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
import { skipHeldItem } from './write-low/skip-held-item'
import { muteCaye } from './write-low/mute-caye'
import { unmuteCaye } from './write-low/unmute-caye'
import { archiveThread } from './write-low/archive-thread'
import { addInternalNote } from './write-low/add-internal-note'
import { sendPaymentConfirmation } from './write-low/send-payment-confirmation'
import { notifyDriver } from './write-low/notify-driver'
import { relateToDirectThread } from './write-low/relate-to-direct-thread'
import { getMyAssignments } from './read/get-my-assignments'
import { getLogisticsFacts } from './read/get-logistics-facts'
import { escalateDriverQuestion } from './write-low/escalate-driver-question'
import { getCronHealth } from './admin/read/get-cron-health'
import { getWorkspaceAutonomy } from './admin/read/get-workspace-autonomy'
import { triggerCron } from './admin/write-high/trigger-cron'
import { setWorkspaceAutonomy } from './admin/write-high/set-workspace-autonomy'
import { gateAdminHighRisk } from './admin/admin-high-risk-gate'
import { checkAvailabilityTool } from './read/front-desk/check-availability'
import { lookupPriceTool } from './read/front-desk/lookup-price'
import { findBookingsTool } from './read/front-desk/find-bookings'
import { sendCustomerReply } from './write-high/send-customer-reply'
import { createCustomerBooking } from './write-high/create-customer-booking'

type AnyTool = Tool<never>

export const TOOL_REGISTRY: AnyTool[] = [
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
  listStandingRules as AnyTool,
  getServices as AnyTool,
  getTeamMembers as AnyTool,
  getChannelStatus as AnyTool,
  getOutreachStatus as AnyTool,
  getConnectLink as AnyTool,
  recordChannelIntake as AnyTool,
  markHandled as AnyTool,
  scheduleReminder as AnyTool,
  sendOperatorMessage as AnyTool,
  addServiceAvailabilityRule as AnyTool,
  addBusinessFact as AnyTool,
  confirmFactCandidate as AnyTool,
  dismissFactCandidate as AnyTool,
  removeBusinessFact as AnyTool,
  addStandingRule as AnyTool,
  removeStandingRule as AnyTool,
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
  relateToDirectThread as AnyTool,
  // External-draft intent is checked BEFORE the ordinary high-risk gate.
  // That prevents a bare "draft please" from even staging the wrong kind
  // of artifact; gateHighRisk still owns the separate confirmation round
  // trip once explicit email-draft intent is established.
  ...HIGH_RISK_TOOLS.map((t) =>
    gateExternalDraftIntent(gateHighRisk(t) as AnyTool) as AnyTool
  ),
  confirmPendingAction as AnyTool,
  getMyAssignments as AnyTool,
  getLogisticsFacts as AnyTool,
  escalateDriverQuestion as AnyTool,
  checkAvailabilityTool as AnyTool,
  lookupPriceTool as AnyTool,
  findBookingsTool as AnyTool,
  sendCustomerReply as AnyTool,
  createCustomerBooking as AnyTool,
  getCronHealth as AnyTool,
  getWorkspaceAutonomy as AnyTool,
  gateAdminHighRisk(triggerCron) as AnyTool,
  gateAdminHighRisk(setWorkspaceAutonomy) as AnyTool,
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
