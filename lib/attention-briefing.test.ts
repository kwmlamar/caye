import { describe, it, expect } from 'vitest'
import { summarizeEscalation, sortEscalationsByPriority } from './attention-briefing'

describe('summarizeEscalation', () => {
  it('uses clean internal_context as-is, including a trailing question as the decision', () => {
    const { body, decision } = summarizeEscalation({
      internal_context:
        "Emily wants to book the Guided Golf Cart Tour for 3 people, but that's below the normal group " +
        "minimum. Can I offer her a private rate, or would you rather she join a bigger group?",
      customer_facing_message: null,
      category: 'policy',
    })
    expect(body).toBe("Emily wants to book the Guided Golf Cart Tour for 3 people, but that's below the normal group minimum.")
    expect(decision).toBe('Can I offer her a private rate, or would you rather she join a bigger group?')
  })

  it('does not split off a decision when the text is one sentence, or does not end in a question', () => {
    const single = summarizeEscalation({
      internal_context: "I answered her, but I wasn't fully sure of what I said.",
      customer_facing_message: null,
      category: null,
    })
    expect(single.decision).toBeNull()
    expect(single.body).toBe("I answered her, but I wasn't fully sure of what I said.")

    const noQuestion = summarizeEscalation({
      internal_context: 'She asked about refunds. I told her that is your call, not mine.',
      customer_facing_message: null,
      category: 'policy',
    })
    expect(noQuestion.decision).toBeNull()
  })

  it('falls back to a category-based line when internal_context leaks jargon', () => {
    const { body, decision } = summarizeEscalation({
      internal_context: 'lookup_price returned group_size_below_minimum for the golf cart tour.',
      customer_facing_message: null,
      category: 'policy',
    })
    expect(body).toMatch(/policy/i)
    expect(body).not.toMatch(/lookup_price|group_size_below_minimum/)
    expect(decision).toBeNull()
  })

  it('falls back to customer_facing_message when internal_context is empty', () => {
    const { body } = summarizeEscalation({
      internal_context: null,
      customer_facing_message: "Let me check with the team and get back to you on that.",
      category: 'gap',
    })
    expect(body).toBe('Let me check with the team and get back to you on that.')
  })

  it('falls back to a generic line when nothing usable is available', () => {
    const { body } = summarizeEscalation({ internal_context: null, customer_facing_message: null, category: null })
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toMatch(/null|undefined/)
  })

  it('truncates a long single-sentence body with no decision to split off', () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ') + '?'
    const { body, decision } = summarizeEscalation({ internal_context: long, customer_facing_message: null, category: null })
    expect(body.endsWith('…')).toBe(true)
    expect(body.split(/\s+/).length).toBeLessThanOrEqual(56)
    expect(decision).toBeNull()
  })

  it('preserves a real trailing decision question even when the full note runs past the body word cap', () => {
    // Shape of a real production escalation (2026-08-13, Karin Roberts /
    // Bimini): 103 words total, genuinely clean, decision is the last
    // sentence. A flat truncate-then-split would have cut the ask itself.
    const note =
      'Karin Roberts is following up on an overdue deposit invoice for the North Bimini Heritage Tour on ' +
      'November 6 for 2 guests ($220 total). A prior message in the thread promised an invoice would be sent ' +
      'shortly, but it has not arrived. Karin was also quoted a 25% deposit ($55) with the balance ($165) due ' +
      'by October 30 — those figures came from a prior reply. Please send the deposit invoice to Karin as soon ' +
      'as possible. Want me to confirm the booking is created in the system and flag it as pending payment, ' +
      'or is the invoice handled on your end separately?'
    const { body, decision } = summarizeEscalation({ internal_context: note, customer_facing_message: null, category: 'policy' })
    expect(decision).toBe(
      'Want me to confirm the booking is created in the system and flag it as pending payment, or is the invoice handled on your end separately?'
    )
    expect(body).toMatch(/Karin Roberts is following up/)
    expect(body).not.toMatch(/Want me to confirm/)
  })
})

describe('sortEscalationsByPriority', () => {
  const base = { booking_meta: null, created_at: '2026-08-10T00:00:00Z' }

  it('surfaces a booking-linked escalation ahead of an older non-booking one', () => {
    const withBooking = { ...base, id: 'a', created_at: '2026-08-12T00:00:00Z', booking_meta: { service_name: 'Golf Cart Tour', booking_date: '2026-08-20', number_of_people: 3 } }
    const older = { ...base, id: 'b', created_at: '2026-08-01T00:00:00Z' }
    const sorted = sortEscalationsByPriority([older, withBooking])
    expect(sorted[0].id).toBe('a')
  })

  it('falls back to oldest-first when neither or both have a booking', () => {
    const a = { ...base, id: 'a', created_at: '2026-08-05T00:00:00Z' }
    const b = { ...base, id: 'b', created_at: '2026-08-01T00:00:00Z' }
    const sorted = sortEscalationsByPriority([a, b])
    expect(sorted.map((e) => e.id)).toEqual(['b', 'a'])
  })
})
