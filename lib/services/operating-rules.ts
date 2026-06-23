/**
 * operating-rules.ts
 *
 * Pure, deterministic evaluation of whether a business is open on a given date.
 * Two rule types:
 *   - blackout_dates: closure ranges (one-time 'YYYY-MM-DD' or recurring 'MM-DD')
 *   - owner_only_weekdays: weekdays Caye must route to the owner, not auto-handle
 *
 * Kept side-effect-free and DB-free so the date logic (especially the
 * year-boundary wrap on recurring ranges like Dec 23 → Jan 3) is unit-testable.
 */

export interface BlackoutRange {
  /** 'YYYY-MM-DD' when one-time, 'MM-DD' when recurring_annually. */
  start: string
  /** 'YYYY-MM-DD' when one-time, 'MM-DD' when recurring_annually. Inclusive. */
  end: string
  label?: string
  /** When true, start/end are 'MM-DD' and match any year (supports wrap). */
  recurring_annually?: boolean
}

export interface OperatingRules {
  blackout_dates: BlackoutRange[]
  /** 0=Sunday .. 6=Saturday. */
  owner_only_weekdays: number[]
}

export type OperatingVerdict =
  | { status: 'open' }
  | { status: 'closed'; label: string }
  | { status: 'owner_only'; weekday: number }

/** Day of week for a 'YYYY-MM-DD' date, parsed as UTC to avoid tz off-by-one. */
function weekdayOf(dateISO: string): number {
  return new Date(`${dateISO}T00:00:00Z`).getUTCDay()
}

/** 'YYYY-MM-DD' → 'MM-DD'. */
function monthDay(dateISO: string): string {
  return dateISO.slice(5, 10)
}

function inOneTimeRange(dateISO: string, start: string, end: string): boolean {
  // ISO strings compare lexicographically in chronological order.
  return dateISO >= start && dateISO <= end
}

function inRecurringRange(dateISO: string, start: string, end: string): boolean {
  const md = monthDay(dateISO)
  if (start <= end) {
    // Normal range within a single year, e.g. 08-01 .. 08-09.
    return md >= start && md <= end
  }
  // Wrapped range across the year boundary, e.g. 12-23 .. 01-03.
  return md >= start || md <= end
}

function matchesBlackout(dateISO: string, range: BlackoutRange): boolean {
  return range.recurring_annually
    ? inRecurringRange(dateISO, range.start, range.end)
    : inOneTimeRange(dateISO, range.start, range.end)
}

/**
 * Evaluate a single 'YYYY-MM-DD' date against the workspace's operating rules.
 *
 * Precedence: a full closure (blackout) wins over owner_only — a customer
 * asking about a closed Sunday should hear "we're closed," which is clearer
 * than "the owner will follow up."
 */
export function evaluateOperatingDate(
  dateISO: string,
  rules: OperatingRules
): OperatingVerdict {
  for (const range of rules.blackout_dates ?? []) {
    if (matchesBlackout(dateISO, range)) {
      return { status: 'closed', label: range.label || 'Closed' }
    }
  }

  const weekday = weekdayOf(dateISO)
  if ((rules.owner_only_weekdays ?? []).includes(weekday)) {
    return { status: 'owner_only', weekday }
  }

  return { status: 'open' }
}
