import { describe, it, expect } from 'vitest'
import {
  buildOperatorBrief,
  buildCustomerRecap,
  parseLabelledFields,
  summarizeIntake,
  summarizeIntakeBody,
  truncate,
  shortDate,
  longDate,
} from './operator-brief'

/**
 * Regression fixture: Robert's real Bimini Island Tours web form submission
 * (2026-08-06), reproduced verbatim from unified_messages. This is the body
 * that used to become:
 *
 *   Reason: Custom request — "Name: Robert Email: Carron12321@gmail.com
 *   Phone: 5738038725 Guests: 5 Age Range: Mixed Ages Date: Mo"
 *
 * — cut mid-word at 100 chars with no ellipsis, dropping the date, the tour
 * type, and the entire Notes field (a guest with limited mobility, which is
 * what actually decides whether the tour can run).
 */
const ROBERT_BODY = [
  'Name: Robert',
  'Email: Carron12321@gmail.com',
  'Phone: 5738038725',
  'Guests: 5',
  'Age Range: Mixed Ages',
  'Date: Monday, August 31, 2026',
  'DateISO: 2026-08-31',
  'Tour: Private VIP Custom Tour',
  'Notes: Traveling with my mother who is limited in walking, but loves local foods and experiences. With us will be my father, wife, and daughter who is 10.',
].join('\n')

describe('parseLabelledFields', () => {
  it('parses a web-form body into ordered fields', () => {
    const fields = parseLabelledFields(ROBERT_BODY)
    expect(fields).not.toBeNull()
    expect(fields).toHaveLength(9)
    expect(fields![0]).toEqual({ label: 'Name', value: 'Robert' })
    expect(fields![5]).toEqual({ label: 'Date', value: 'Monday, August 31, 2026' })
  })

  it('returns null for ordinary prose with an incidental colon', () => {
    expect(parseLabelledFields('Note: I loved the tour, thanks so much!')).toBeNull()
  })

  it('returns null for fewer than three labelled lines', () => {
    expect(parseLabelledFields('Name: Robert\nEmail: robert@example.com')).toBeNull()
  })
})

describe('truncate', () => {
  it('leaves short text untouched', () => {
    expect(truncate('short text', 100)).toBe('short text')
  })

  it('cuts at a word boundary and appends a real ellipsis, never mid-word', () => {
    // This is the exact failure mode being fixed: the old 100-char slice
    // produced "...Date: Mo" — half of "Monday" with no ellipsis at all,
    // silently dropping the date. truncate() must never do that: either a
    // whole word survives, or an ellipsis marks the cut.
    const result = truncate('The quick brown fox jumps over the lazy dog', 20)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(20)
    // "fox" must appear whole or not at all — never as "fo".
    expect(result).not.toMatch(/\bfo\b/)
  })

  it('collapses internal whitespace before measuring', () => {
    expect(truncate('a   b\n\nc', 100)).toBe('a b c')
  })
})

describe('shortDate / longDate', () => {
  it('formats a short operator-facing date', () => {
    expect(shortDate('2026-08-31')).toBe('Mon 8/31')
  })

  it('formats a long customer-facing date', () => {
    expect(longDate('2026-08-31')).toBe('Monday, August 31')
  })

  it('falls back to the raw string when unparseable', () => {
    expect(shortDate('not-a-date')).toBe('not-a-date')
  })
})

describe('buildOperatorBrief — structured form path (Robert fixture)', () => {
  it('surfaces date, party size, and tour type in the headline', () => {
    const result = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
    })
    expect(result.targetDate).toBe('2026-08-31')
    expect(result.brief).toContain('Mon 8/31 · Robert · 5 guests · Private VIP Custom Tour')
  })

  it('never truncates the Notes field — the field that decides the answer', () => {
    const result = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
    })
    expect(result.brief).toContain('limited in walking')
    expect(result.brief).toContain('daughter who is 10')
  })

  it('includes calendar availability when supplied', () => {
    const clear = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
      availability: { dateISO: '2026-08-31', bookingCount: 0 },
    })
    expect(clear.brief).toContain("Calendar's clear that day.")

    const busy = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
      availability: { dateISO: '2026-08-31', bookingCount: 2 },
    })
    expect(busy.brief).toContain('Already 2 on the calendar that day.')
  })

  it('includes contact info and the already-sent line', () => {
    const result = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
      alreadySent: 'Thanks for the details. Let me check on this with the team and circle back shortly.',
    })
    expect(result.brief).toContain('5738038725')
    // Preserved verbatim from the form, capitalization and all — the
    // composer never normalizes customer-supplied data.
    expect(result.brief).toContain('Carron12321@gmail.com')
    expect(result.brief.toLowerCase()).toContain('holding line')
  })

  it('ends with the custom_request closing ask', () => {
    const result = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
    })
    expect(result.brief).toMatch(/what should I quote/i)
  })

  it('produces a template-safe one-line summary with no newlines', () => {
    const result = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
    })
    expect(result.oneLine).not.toMatch(/[\n\t]/)
    expect(result.oneLine.length).toBeLessThanOrEqual(160)
    expect(result.oneLine).toContain('Mon 8/31')
  })

  it('never refers to the customer by a guessed pronoun', () => {
    const result = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Robert',
      body: ROBERT_BODY,
    })
    // "his"/"her"/"she"/"he" as standalone words would indicate a guessed
    // pronoun — the composer only ever uses the customer's name.
    expect(result.brief).not.toMatch(/\b(he|him|his|she|her)\b/i)
  })
})

describe('buildOperatorBrief — prose fallback', () => {
  it('falls back to internalContext when the body is not a parseable form', () => {
    const result = buildOperatorBrief({
      trigger: 'complaint',
      contactName: 'Marissa',
      body: 'This is unacceptable, I want my money back immediately.',
      internalContext:
        'Marissa is upset about a delayed refund and wants it processed today.',
    })
    expect(result.targetDate).toBeNull()
    expect(result.brief).toContain('Marissa is upset about a delayed refund')
    expect(result.brief).toMatch(/apology|make-good/i)
  })
})

describe('buildCustomerRecap', () => {
  it('recaps the headline and quotes Notes verbatim, without interpreting it', () => {
    const recap = buildCustomerRecap(ROBERT_BODY)
    expect(recap).toContain('Monday, August 31')
    expect(recap).toContain('Private VIP Custom Tour')
    expect(recap).toContain('for 5')
    // Verbatim quote, not a paraphrase like "accessibility need" or
    // "mobility limitation" — buildCustomerRecap must never interpret.
    expect(recap).toContain('limited in walking')
    expect(recap).not.toMatch(/accessib/i)
    expect(recap).not.toMatch(/mobility/i)
  })

  it('returns null for prose with nothing to recap', () => {
    expect(buildCustomerRecap('Hey, do you run tours on Sundays?')).toBeNull()
  })
})

describe('summarizeIntake / summarizeIntakeBody', () => {
  // The get_customer regression: Robert's party size of 5 was sitting in
  // unified_conversations.metadata.form_fields the whole time, but the tool
  // never selected it — so Caye drafted "I don't know his party size, so I'll
  // leave pricing open-ended" for a guest who had stated it on the form.
  it('resolves the party size the get_customer draft was missing', () => {
    const intake = summarizeIntakeBody(ROBERT_BODY)
    expect(intake?.guests).toBe('5')
    expect(intake?.service).toBe('Private VIP Custom Tour')
    expect(intake?.dateISO).toBe('2026-08-31')
    expect(intake?.notes).toContain('limited in walking')
    expect(intake?.email).toBe('Carron12321@gmail.com')
    expect(intake?.phone).toBe('5738038725')
  })

  it('reads the stored [{label, value}] form_fields shape directly', () => {
    // Exactly what metadata.form_fields.fields holds for Robert's thread.
    const intake = summarizeIntake([
      { label: 'Name', value: 'Robert' },
      { label: 'Guests', value: '5' },
      { label: 'Tour', value: 'Private VIP Custom Tour' },
    ])
    expect(intake.name).toBe('Robert')
    expect(intake.guests).toBe('5')
  })

  it('resolves label aliases rather than requiring exact keys', () => {
    const intake = summarizeIntake([
      { label: 'Party Size', value: '4' },
      { label: 'Preferred Date', value: 'Friday' },
      { label: 'Special Requests', value: 'window seat' },
    ])
    expect(intake.guests).toBe('4')
    expect(intake.date).toBe('Friday')
    expect(intake.notes).toBe('window seat')
  })

  it('keeps unrecognized fields in extras instead of dropping them', () => {
    const intake = summarizeIntake([
      { label: 'Name', value: 'Robert' },
      { label: 'Age Range', value: 'Mixed Ages' },
      { label: 'Guests', value: '5' },
    ])
    expect(intake.extras).toEqual([{ label: 'Age Range', value: 'Mixed Ages' }])
  })

  it('returns null for prose that is not a form', () => {
    expect(summarizeIntakeBody('Hey, do you run tours on Sundays?')).toBeNull()
  })
})
