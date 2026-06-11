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

/**
 * All tools available to the back-office agent.
 *
 * Read tools (10): #38 + #40 — autonomous execution, no confirmation.
 * Low-risk write tools: #37 (mute, mark_handled, archive, ...)
 * High-risk write tools: #42/#43 — gated through confirmation flow.
 */
type AnyTool = Tool<never>

export const TOOL_REGISTRY: AnyTool[] = [
  // Read tools — autonomous
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
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
