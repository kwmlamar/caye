/**
 * service-availability.ts
 *
 * "Can this tour run, on this date, for this party?" — decided from data,
 * not from prose the model may or may not honour.
 *
 * Pure and DB-free so the weekday/party arithmetic is unit-testable, matching
 * operating-rules.ts and resolve-tier.ts. The lookup lives in the caller.
 *
 * THE GAP THIS CLOSES
 * Two things Mrs. Max taught on 2026-08-09 had nowhere to live:
 *   - "no sundays only if it is a group of 6 or more persons ... that is the
 *      full bimini experience"
 *   - "they have to know that the minimum is 3 - 4 persons"
 * business_facts stores them as advisory prose. caye_standing_rules can't
 * express them at all — its triggers are a service name or a literal keyword,
 * with no notion of a date or a headcount. So both became things the model
 * was trusted to remember, which is the posture that produced a flat solo
 * total from a per-person shared rate forty minutes after she corrected it.
 *
 * WHY 'unavailable' AND 'departure_minimum' ARE NOT THE SAME THING
 * A departure minimum is not a refusal. Delysia Weeks was a solo traveller
 * on a tour needing three, and the correct answer — the one the owner
 * approved — was to quote her the shared rate anyway and say plainly that it
 * needs the numbers to run. Collapsing the two effects would turn Caye into
 * a bouncer on exactly the enquiries she is supposed to be converting.
 */

export interface ServiceAvailabilityRule {
  id: string
  /** 0=Sunday .. 6=Saturday, matching getUTCDay(). Null = every day. */
  weekday: number | null
  effect: 'unavailable' | 'departure_minimum'
  /**
   * 'unavailable'       — party size at/above which the block LIFTS.
   *                       Null means blocked regardless of party size.
   * 'departure_minimum' — headcount needed for the tour to actually run.
   */
  min_party: number | null
  /** Owner's own words, surfaced as the reason. */
  note: string | null
}

export type AvailabilityVerdict =
  | { status: 'available' }
  | {
      status: 'unavailable'
      /** The party size that would lift the block, when one exists. */
      availableFromPartySize: number | null
      reason: string | null
      ruleId: string
    }
  | {
      status: 'available_below_minimum'
      /** Headcount the tour needs in order to run. */
      departureMinimum: number
      reason: string | null
      ruleId: string
    }

/** Day of week for a 'YYYY-MM-DD' date, parsed as UTC to avoid tz off-by-one. */
export function weekdayOf(dateISO: string): number {
  return new Date(`${dateISO}T00:00:00Z`).getUTCDay()
}

function appliesToDay(rule: ServiceAvailabilityRule, weekday: number): boolean {
  return rule.weekday === null || rule.weekday === weekday
}

/**
 * Evaluate a service against a requested date and party size.
 *
 * Precedence: a hard block wins over a departure minimum. A customer asking
 * about a Sunday the tour cannot run at all should hear that, not a note
 * about headcount for a departure that was never on offer.
 *
 * `partySize` may be null when the enquiry didn't state one. A hard block
 * with no min_party still applies (the day is closed regardless), but one
 * that could be lifted by a large enough group is NOT applied blind — we
 * don't know the group size yet, so the honest verdict is 'available' and
 * the model asks. Guessing 'unavailable' there would turn a 7-person booking
 * into a refusal.
 */
export function evaluateServiceAvailability(args: {
  rules: ServiceAvailabilityRule[]
  dateISO: string | null
  partySize: number | null
}): AvailabilityVerdict {
  const { rules, dateISO, partySize } = args
  if (!dateISO || rules.length === 0) return { status: 'available' }

  const weekday = weekdayOf(dateISO)
  if (Number.isNaN(weekday)) return { status: 'available' }

  const applicable = rules.filter((r) => appliesToDay(r, weekday))

  for (const rule of applicable.filter((r) => r.effect === 'unavailable')) {
    // No escape hatch — closed that day, full stop.
    if (rule.min_party === null) {
      return {
        status: 'unavailable',
        availableFromPartySize: null,
        reason: rule.note,
        ruleId: rule.id,
      }
    }
    // A large enough group lifts it. Unknown party size is not a small one:
    // stay quiet and let the model ask rather than refuse a group that would
    // have qualified.
    if (partySize !== null && partySize < rule.min_party) {
      return {
        status: 'unavailable',
        availableFromPartySize: rule.min_party,
        reason: rule.note,
        ruleId: rule.id,
      }
    }
  }

  for (const rule of applicable.filter((r) => r.effect === 'departure_minimum')) {
    if (rule.min_party !== null && partySize !== null && partySize < rule.min_party) {
      return {
        status: 'available_below_minimum',
        departureMinimum: rule.min_party,
        reason: rule.note,
        ruleId: rule.id,
      }
    }
  }

  return { status: 'available' }
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/**
 * System-prompt block stating what is true for this specific enquiry.
 *
 * Deliberately states the FACT and forbids contradicting it, without
 * scripting the sentence. The reply still gets written in the owner's voice —
 * same division of labour as buildMatchHintBlock. Returns '' when there is
 * nothing to constrain, so callers can append unconditionally.
 */
export function buildAvailabilityBlock(args: {
  verdict: AvailabilityVerdict
  serviceName: string
  dateISO: string | null
}): string {
  const { verdict, serviceName, dateISO } = args
  if (verdict.status === 'available' || !dateISO) return ''

  const dayName = WEEKDAY_NAMES[weekdayOf(dateISO)] ?? 'that day'
  const when = `${dayName} ${dateISO}`

  if (verdict.status === 'unavailable') {
    const lift =
      verdict.availableFromPartySize !== null
        ? ` It becomes available for groups of ${verdict.availableFromPartySize} or more.`
        : ''
    return (
      '\n\nAVAILABILITY — DECIDED, NOT NEGOTIABLE:\n' +
      `- "${serviceName}" CANNOT run on ${when}.${lift}\n` +
      (verdict.reason ? `- Owner's reason: ${verdict.reason}\n` : '') +
      '- Say so plainly and offer the alternatives that CAN run that day. Do not ' +
      'quote a price for it, do not offer to check, and do not hold the date. ' +
      'This was checked against the calendar rules directly — it is not a guess ' +
      'you may soften or work around.'
    )
  }

  return (
    '\n\nDEPARTURE MINIMUM — THE QUOTE IS FINE, THE CAVEAT IS MANDATORY:\n' +
    `- "${serviceName}" needs ${verdict.departureMinimum} guests to run, and this party is smaller.\n` +
    (verdict.reason ? `- Owner's reason: ${verdict.reason}\n` : '') +
    '- Still quote the shared rate and still offer to reserve the spot — this is ' +
    'NOT a refusal. But the reply MUST say the tour needs those numbers to go ' +
    'ahead and name what happens if it does not (recommend an alternative). ' +
    'A per-person shared rate must never be restated as a flat total for this party.'
  )
}
