import type { Tool } from './types'
import { getCalendar } from './read/get-calendar'
import { getHeldQueue } from './read/get-held-queue'
import { getTodaySummary } from './read/get-today-summary'

/**
 * All tools available to the back-office agent.
 *
 * Slice #38: 3 read tools wired (calendar, held queue, today summary).
 * Slices #40 (more reads), #37 (low-risk writes), #42/#43 (high-risk
 * writes) extend this registry.
 */
// Registry stores tools without a specific input type — the input_schema
// declared on each tool is the source of truth at runtime, and the
// execute loop hands Claude's parsed `input` straight to the tool.
type AnyTool = Tool<never>

export const TOOL_REGISTRY: AnyTool[] = [
  getCalendar as AnyTool,
  getHeldQueue as AnyTool,
  getTodaySummary as AnyTool,
]

export function findTool(name: string): AnyTool | undefined {
  return TOOL_REGISTRY.find((t) => t.name === name)
}
