import 'server-only'

/**
 * Heuristic urgency classifier for held inbound messages.
 *
 * Per Phase 5a fallback rules: any mention of a date within 7 days from
 * now → urgent. Time-sensitive language ("today", "tomorrow", "right now",
 * etc.) → urgent. Returning-customer signals are passed via `isReturning`.
 *
 * Kept separate from caye-reply.ts so it can run cheaply without an extra
 * LLM round-trip, and so the webhook layer (which already has the raw
 * inbound text) can decide scheduling without re-asking Claude.
 */

export type HoldUrgency = 'urgent' | 'routine'

const TIME_SENSITIVE_PATTERNS = [
  /\btoday\b/i,
  /\btomorrow\b/i,
  /\bright now\b/i,
  /\bthis (morning|afternoon|evening|weekend)\b/i,
  /\basap\b/i,
  /\burgent\b/i,
  /\bemergency\b/i,
]

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

export interface UrgencyInput {
  inboundBody: string
  isReturningCustomer?: boolean
}

export function classifyHoldUrgency(input: UrgencyInput): HoldUrgency {
  const text = input.inboundBody ?? ''

  if (input.isReturningCustomer) return 'urgent'
  if (TIME_SENSITIVE_PATTERNS.some((re) => re.test(text))) return 'urgent'
  if (mentionsDateWithinNextWeek(text)) return 'urgent'

  return 'routine'
}

/**
 * Best-effort date detection. We're not trying to parse every natural-language
 * date — just catch the common shapes:
 *   - "June 3", "Jun 3rd", "the 3rd of June"
 *   - "6/3", "6/3/26", "06-03"
 *   - day-of-week names ("Monday", "this Friday")
 */
function mentionsDateWithinNextWeek(text: string): boolean {
  const now = new Date()
  const horizonMs = 7 * 24 * 60 * 60 * 1000

  // Day-of-week names — almost always refer to the upcoming occurrence.
  const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  if (dayNames.some((d) => new RegExp(`\\b${d}\\b`, 'i').test(text))) return true

  // Month name + day number
  for (let m = 0; m < 12; m++) {
    const re = new RegExp(`\\b(${MONTHS[m]}|${MONTHS[m].slice(0, 3)})\\b[^\\d]{0,8}(\\d{1,2})`, 'i')
    const match = text.match(re)
    if (match) {
      const day = Number(match[2])
      if (day >= 1 && day <= 31) {
        const candidate = candidateDateForMonthDay(m, day, now)
        if (candidate && Math.abs(candidate.getTime() - now.getTime()) < horizonMs) return true
      }
    }
  }

  // Numeric m/d or m-d
  const numericMatches = text.matchAll(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g)
  for (const m of numericMatches) {
    const month = Number(m[1]) - 1
    const day = Number(m[2])
    if (month >= 0 && month < 12 && day >= 1 && day <= 31) {
      const candidate = candidateDateForMonthDay(month, day, now)
      if (candidate && Math.abs(candidate.getTime() - now.getTime()) < horizonMs) return true
    }
  }

  return false
}

function candidateDateForMonthDay(month: number, day: number, now: Date): Date | null {
  // Pick this year, or next year if it's already passed by >14 days.
  let year = now.getUTCFullYear()
  let candidate = new Date(Date.UTC(year, month, day))
  if (candidate.getTime() < now.getTime() - 14 * 24 * 60 * 60 * 1000) {
    year += 1
    candidate = new Date(Date.UTC(year, month, day))
  }
  return candidate
}
