import type { Tool } from './types'
import { getCalendar } from './read/get-calendar'
import { getHeldQueue } from './read/get-held-queue'
import { getTodaySummary } from './read/get-today-summary'
import { getRevenue } from './read/get-revenue'
import { getCustomer } from './read/get-customer'
import { getCustomerHistory } from './read/get-customer-history'
import { getRecentActivity } from './read/get-recent-activity'
import { getRecentBookings } from './read/get-recent-bookings'
import { getPendingQuotes } from './read/get-pending-quotes'
import { searchThreads } from './read/search-threads'
import { queryBusinessKnowledge } from './read/query-business-knowledge'
import { getServices } from './read/get-services'
import { markHandled } from './write-low/mark-handled'
import { addBusinessFact } from './write-low/add-business-fact'
import { updateServicePrice } from './write-low/update-service-price'
import { addService } from './write-low/add-service'
import { setServiceVisibility } from './write-low/set-service-visibility'
import { updateBusinessHours } from './write-low/update-business-hours'
import { addBlackoutDate } from './write-low/add-blackout-date'
import { updateVoiceRegister } from './write-low/update-voice-register'
import { addVoiceSample } from './write-low/add-voice-sample'
import { addTeamMember } from './write-low/add-team-member'
import { updateTeamMemberPermissions } from './write-low/update-team-member-permissions'
import { switchWorkspace } from './write-low/switch-workspace'
import { removeTeamMember } from './write-high/remove-team-member'
import { removeService } from './write-high/remove-service'
import { removeBlackoutDate } from './write-high/remove-blackout-date'
import { skipHeldItem } from './write-low/skip-held-item'
import { muteCaye } from './write-low/mute-caye'
import { unmuteCaye } from './write-low/unmute-caye'
import { archiveThread } from './write-low/archive-thread'
import { addInternalNote } from './write-low/add-internal-note'
import { sendPaymentConfirmation } from './write-low/send-payment-confirmation'
import { sendReply } from './write-high/send-reply'
import { confirmBooking } from './write-high/confirm-booking'
import { rescheduleBooking } from './write-high/reschedule-booking'
import { cancelBooking } from './write-high/cancel-booking'
import { notifyDriver } from './write-low/notify-driver'
import { getMyAssignments } from './read/get-my-assignments'
import { getLogisticsFacts } from './read/get-logistics-facts'
import { escalateDriverQuestion } from './write-low/escalate-driver-question'

/**
 * All tools available to the back-office agent.
 *
 * Read tools (10): #38 + #40 — autonomous execution
 * Low-risk write tools (18): #37 — autonomous execution
 * High-risk write tools (6): #42/#43 — gated through confirmation flow
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
  getCustomer as AnyTool,
  getCustomerHistory as AnyTool,
  getRecentActivity as AnyTool,
  getRecentBookings as AnyTool,
  getPendingQuotes as AnyTool,
  searchThreads as AnyTool,
  queryBusinessKnowledge as AnyTool,
  getServices as AnyTool,
  // Low-risk write
  markHandled as AnyTool,
  addBusinessFact as AnyTool,
  updateServicePrice as AnyTool,
  addService as AnyTool,
  setServiceVisibility as AnyTool,
  updateBusinessHours as AnyTool,
  addBlackoutDate as AnyTool,
  updateVoiceRegister as AnyTool,
  addVoiceSample as AnyTool,
  addTeamMember as AnyTool,
  updateTeamMemberPermissions as AnyTool,
  switchWorkspace as AnyTool,
  skipHeldItem as AnyTool,
  muteCaye as AnyTool,
  unmuteCaye as AnyTool,
  archiveThread as AnyTool,
  addInternalNote as AnyTool,
  sendPaymentConfirmation as AnyTool,
  notifyDriver as AnyTool,
  // High-risk write (confirmation flow enforced via prompt)
  sendReply as AnyTool,
  confirmBooking as AnyTool,
  rescheduleBooking as AnyTool,
  cancelBooking as AnyTool,
  removeService as AnyTool,
  removeBlackoutDate as AnyTool,
  removeTeamMember as AnyTool,
  // Driver mode
  getMyAssignments as AnyTool,
  getLogisticsFacts as AnyTool,
  escalateDriverQuestion as AnyTool,
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
