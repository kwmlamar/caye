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
import { markHandled } from './write-low/mark-handled'
import { addBusinessFact } from './write-low/add-business-fact'
import { updateServicePrice } from './write-low/update-service-price'
import { addService } from './write-low/add-service'
import { setServiceVisibility } from './write-low/set-service-visibility'
import { removeService } from './write-high/remove-service'
import { skipHeldItem } from './write-low/skip-held-item'
import { muteCaye } from './write-low/mute-caye'
import { unmuteCaye } from './write-low/unmute-caye'
import { archiveThread } from './write-low/archive-thread'
import { addInternalNote } from './write-low/add-internal-note'
import { sendReply } from './write-high/send-reply'
import { confirmBooking } from './write-high/confirm-booking'
import { rescheduleBooking } from './write-high/reschedule-booking'
import { cancelBooking } from './write-high/cancel-booking'

/**
 * All tools available to the back-office agent.
 *
 * Read tools (10): #38 + #40 — autonomous execution
 * Low-risk write tools (6): #37 — autonomous execution
 * High-risk write tools (6): #42/#43 — gated through confirmation flow
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
  // Low-risk write
  markHandled as AnyTool,
  addBusinessFact as AnyTool,
  updateServicePrice as AnyTool,
  addService as AnyTool,
  setServiceVisibility as AnyTool,
  skipHeldItem as AnyTool,
  muteCaye as AnyTool,
  unmuteCaye as AnyTool,
  archiveThread as AnyTool,
  addInternalNote as AnyTool,
  // High-risk write (confirmation flow enforced via prompt)
  sendReply as AnyTool,
  confirmBooking as AnyTool,
  rescheduleBooking as AnyTool,
  cancelBooking as AnyTool,
  removeService as AnyTool,
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
