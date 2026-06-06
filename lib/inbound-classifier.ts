/**
 * Pure inbound-message classifier. Looks at the body + subject and
 * heuristically picks a situational category that Caye uses to modulate
 * tone (e.g. lead with empathy on complaints, stay neutral on cancels).
 *
 * Regex/keyword based on purpose — deterministic, no API call, fast.
 * Misclassifications are acceptable: when uncertain, we return null and
 * Caye falls back to her default tone (which is already pretty good).
 *
 * Extracted from caye-reply.ts so the classifier patterns can be unit
 * tested without server-only deps and tweaked over time without touching
 * the reply loop.
 */

export type InboundCategory =
  | 'complaint'
  | 'gratitude'
  | 'cancellation_request'
  | 'rescheduling'
  | 'b2b_partnership'
  | 'booking_inquiry'
  | 'general_question'

export interface ClassificationResult {
  category: InboundCategory | null
  /** Why this category fired — useful for logging + debugging. Empty when
   *  category is null. */
  matched: string | null
}

interface Pattern {
  category: InboundCategory
  /** Higher priority wins ties when multiple patterns match. */
  priority: number
  test: (body: string, subject: string) => string | null
}

// Compiled once at module scope. Order in the array doesn't matter —
// priority determines the winner.
const PATTERNS: Pattern[] = [
  // ── COMPLAINT (highest priority — catch these first) ─────────────────
  {
    category: 'complaint',
    priority: 100,
    test: text =>
      /\b(disappointed|unacceptable|terrible|awful|horrible|never again|worst|complaint|complain|refund|demand|angry|upset|furious|ridiculous|unhappy|let down|frustrating|frustrated|rude|unprofessional|appalling|disgusted)\b/i.exec(text)?.[0] ?? null,
  },

  // ── CANCELLATION_REQUEST ────────────────────────────────────────────
  {
    category: 'cancellation_request',
    priority: 90,
    test: text => {
      // Verb "cancel" must appear in an action context — not "cancellation policy" or similar
      const m = /\b(cancel|cancelling|canceling|cancelled|cancel my|cancel our|cancel the booking|wont be able to make it|can't make it|can no longer|need to call off|please cancel)\b/i.exec(text)
      // Exclude when the only match is part of "cancellation policy" phrase
      if (m && /cancellation policy/i.test(text) && !/\bcancel\b(?!lation policy)/i.test(text)) {
        return null
      }
      return m?.[0] ?? null
    },
  },

  // ── RESCHEDULING ────────────────────────────────────────────────────
  {
    category: 'rescheduling',
    priority: 85,
    test: text =>
      /\b(reschedule|reschedul|move my booking|push my booking|change the date|change my date|different day|different time|switch to|push it back|push back|earlier date|later date|push.*\b(by|to)\b)\b/i.exec(text)?.[0] ?? null,
  },

  // ── GRATITUDE (short thanks-only messages) ──────────────────────────
  {
    category: 'gratitude',
    priority: 70,
    test: text => {
      // Only fire when gratitude is the DOMINANT shape — short message
      // with thanks keywords, no booking-related question.
      const trimmed = text.trim()
      if (trimmed.length > 200) return null
      const m = /\b(thanks|thank you|much appreciated|appreciate it|cheers|grateful|amazing|fantastic|loved it|wonderful|perfect)\b/i.exec(trimmed)
      if (!m) return null
      // Question marks suggest they want something — don't classify as pure gratitude
      if (/\?/.test(trimmed)) return null
      return m[0]
    },
  },

  // ── B2B_PARTNERSHIP (agencies, DMCs, cruise lines, wholesale partners) ─
  // Must outrank booking_inquiry — partnership emails frequently include
  // booking-flavored language ("we'd like to book groups", "availability").
  // Without higher priority, those words win and Caye replies as if to a
  // walk-in guest. The Anastasiya / Virgin Voyages thread is the test case.
  {
    category: 'b2b_partnership',
    priority: 80,
    test: text => {
      // Explicit partnership/agency keywords — any one is enough.
      const strong =
        /\b(partnership|partnering|collaborat(?:e|ion)|wholesale|rate sheet|commission|shore excursion|cruise (?:line|partnership|programme?)|tour operator(?:s)?|DMC|destination management|travel agen(?:t|cy|cies))\b/i.exec(text)?.[0]
      if (strong) return strong

      // Two or more "agency voice" phrases — softer pattern.
      const phrases = [
        /\bour (?:group|guests?|clients?|passengers?|company|agency|programme?)\b/i,
        /\b(?:group|corporate|wholesale|FIT)\s+(?:rates?|pricing|bookings?)\b/i,
        /\bgroup of \d{1,2}\b/i,
        /\b(?:pax|passengers?|guests?)\s+(?:arriving|on the|from the)\s+\w+/i,
      ]
      const hits = phrases.filter(re => re.test(text))
      if (hits.length >= 2) return hits.map(re => re.source).join(' + ')
      return null
    },
  },

  // ── BOOKING_INQUIRY (asking about availability / how to book) ───────
  {
    category: 'booking_inquiry',
    priority: 60,
    test: text =>
      /\b(book|booking|reserve|reservation|availability|available|free this|free on|do you have|space for|spots for|spots left|interested in booking|like to book|want to book|wanting to book|how do i book|how do we book|booking page)\b/i.exec(text)?.[0] ?? null,
  },

  // ── GENERAL_QUESTION (fallback when a question mark is present) ─────
  {
    category: 'general_question',
    priority: 10,
    test: text => (text.includes('?') ? '?' : null),
  },
]

/**
 * Pick the highest-priority pattern that matches. Returns null when no
 * pattern fires (Caye uses her default tone).
 */
export function classifyInbound(body: string, subject: string = ''): ClassificationResult {
  const text = `${subject}\n\n${body}`
  let winner: { pattern: Pattern; matched: string } | null = null
  for (const p of PATTERNS) {
    const m = p.test(text, subject)
    if (m && (!winner || p.priority > winner.pattern.priority)) {
      winner = { pattern: p, matched: m }
    }
  }
  if (!winner) return { category: null, matched: null }
  return { category: winner.pattern.category, matched: winner.matched }
}

/**
 * The tone modifier text added to Caye's system prompt when the inbound
 * is classified. Empty string when category is null (don't add noise).
 */
export function toneHintFor(category: InboundCategory | null): string {
  switch (category) {
    case 'complaint':
      return (
        'INBOUND CONTEXT: this message is a COMPLAINT or expression of dissatisfaction. ' +
        'Lead with empathy and acknowledgment before anything else ("I\'m sorry to hear that…"). ' +
        'Do NOT be defensive, do NOT make excuses, do NOT immediately try to solve the problem. ' +
        'Acknowledge first, then offer to make it right. If specifics are needed that you don\'t ' +
        'have, hold_for_human — complaints often need the owner\'s direct attention.'
      )
    case 'cancellation_request':
      return (
        'INBOUND CONTEXT: the customer is asking to CANCEL an existing booking. ' +
        'Be neutral and helpful — they\'ve already decided. Do NOT try to talk them out of it ' +
        'or upsell alternatives. Follow the cancel flow (find_bookings → cancel_booking).'
      )
    case 'rescheduling':
      return (
        'INBOUND CONTEXT: the customer is asking to RESCHEDULE an existing booking. ' +
        'Helpful and accommodating. Follow the reschedule flow (find_bookings → reschedule_booking). ' +
        'When they don\'t specify a new time, preserve the existing time on the new date.'
      )
    case 'gratitude':
      return (
        'INBOUND CONTEXT: this is a GRATITUDE message — they\'re saying thanks. ' +
        'Match their warmth briefly, then close. Don\'t over-extend, don\'t restart the ' +
        'conversation, don\'t add a sales hook.'
      )
    case 'booking_inquiry':
      return (
        'INBOUND CONTEXT: this is a NEW BOOKING INQUIRY. Welcoming and helpful — confirm ' +
        'what they\'re asking about, check availability if a date is given, move toward booking ' +
        'naturally. Don\'t make them wait for info you already have.'
      )
    case 'b2b_partnership':
      return (
        'INBOUND CONTEXT: this is a B2B / partnership / cruise-line / travel-agency message — ' +
        'not a walk-in guest. Register: professional rather than casual is acceptable here, even ' +
        'if the operator\'s default voice profile is warm-local. Use full names, complete sentences, ' +
        'the operator\'s business name and credentials (licensed, insured, certified) when relevant. ' +
        'Match the formality the other side is using. Do NOT slip into Bahamian dialect with ' +
        'partnership leads — it can read as unprofessional to off-island agencies. Critically: do ' +
        'NOT auto-commit to commercial terms (commission rates, exclusivity, group pricing tiers, ' +
        'wholesale agreements). When the conversation moves past intros into commercial terms, ' +
        'hold_for_human and let the owner negotiate. Partnership relationships are too valuable to ' +
        'risk on AI judgment.'
      )
    case 'general_question':
      return (
        'INBOUND CONTEXT: the customer is asking a question. Answer it directly first, then ' +
        'add any helpful follow-up. Don\'t bury the answer.'
      )
    case null:
    default:
      return ''
  }
}
