import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import type { ToolStatus } from './tools/result'

/**
 * front-desk-telemetry.ts
 *
 * Derives a caye_tool_calls status from what lib/caye-reply.ts's inline tool
 * branches push into their tool_result block.
 *
 * WHY THIS SHAPE (2026-08-12)
 * Front-desk tools are not registry Tool objects — they are `else if
 * (tool.name === ...)` branches, each pushing its own result. Unifying them
 * with TOOL_REGISTRY is issue #14 and is a refactor of a 2,535-line file
 * carrying live customer traffic; it should be done on failure data, not on a
 * hunch. So this reads the result each branch already produces rather than
 * changing any of them.
 *
 * That keeps the change observational: nothing about what the customer
 * receives depends on anything in this file.
 *
 * The blind spot it closes is not hypothetical. add_internal_note failed on
 * 100% of calls from the day it shipped and the only trace was Caye
 * apologising in a chat transcript; the customer-facing path has the same
 * gap, over the tools that create bookings and quote prices.
 */

/** Result shapes the front-desk branches actually return. */
interface ResultLike {
  ok?: unknown
  success?: unknown
  error?: unknown
  reason?: unknown
  match_count?: unknown
}

export interface DerivedOutcome {
  status: ToolStatus
  error: string | null
}

/**
 * Read the outcome back out of a tool_result block.
 *
 * Deliberately conservative: anything that does not positively look like a
 * failure is recorded as SUCCESS, because over-reporting failures in the
 * first week would train whoever reads this table to ignore it — the exact
 * dynamic the migration-drift watchdog was built to avoid.
 */
export function deriveOutcome(
  block: Anthropic.ToolResultBlockParam | undefined
): DerivedOutcome {
  if (!block) {
    // The branch returned without pushing anything. Shouldn't happen; worth
    // seeing if it does.
    return { status: 'FAILED_PERMANENT', error: 'tool produced no result block' }
  }

  const content = typeof block.content === 'string' ? block.content : null

  if (content && content.startsWith('Unknown tool:')) {
    return { status: 'NOT_FOUND', error: content }
  }

  const parsed = parseJson(content)

  // is_error is the branches' own explicit signal and outranks inference.
  if (block.is_error === true) {
    return { status: classify(parsed), error: errorText(parsed) ?? content ?? 'tool reported an error' }
  }

  if (parsed && (parsed.ok === false || parsed.success === false)) {
    return { status: classify(parsed), error: errorText(parsed) ?? 'tool reported a failure' }
  }

  return { status: 'SUCCESS', error: null }
}

/**
 * A booking that collides with an existing one is a CONFLICT, not a generic
 * failure — c96b734 added duplicate detection to exactly this path, and being
 * able to count those separately is most of the point of logging at all.
 */
function classify(parsed: ResultLike | null): ToolStatus {
  const text = (errorText(parsed) ?? '').toLowerCase()
  if (!text) return 'FAILED_PERMANENT'
  if (/already (has|booked|exists)|duplicate|same day/.test(text)) return 'CONFLICT'
  if (/not found|no such|doesn'?t exist|no matching/.test(text)) return 'NOT_FOUND'
  if (/timeout|timed out|unavailable|try again|temporarily|econn|fetch failed/.test(text)) {
    return 'FAILED_RETRYABLE'
  }
  return 'FAILED_PERMANENT'
}

function errorText(parsed: ResultLike | null): string | null {
  if (!parsed) return null
  if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  if (typeof parsed.reason === 'string' && parsed.reason) return parsed.reason
  return null
}

function parseJson(content: string | null): ResultLike | null {
  if (!content) return null
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const value = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null ? (value as ResultLike) : null
  } catch {
    return null
  }
}
