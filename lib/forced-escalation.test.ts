import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { detectForcedEscalation } from './forced-escalation'

describe('detectForcedEscalation', () => {
  it('escalates when classifier returns complaint', () => {
    const result = detectForcedEscalation('this was terrible, i want a refund', 'complaint')
    expect(result?.trigger).toBe('complaint')
    expect(result?.category).toBe('policy')
    expect(result?.routeTo).toBe('owner')
    expect(result?.customerFacingMessage).toMatch(/sorry/i)
  })

  it('escalates when classifier returns b2b_partnership', () => {
    const result = detectForcedEscalation(
      'Reaching out from XYZ DMC about wholesale rates',
      'b2b_partnership'
    )
    expect(result?.trigger).toBe('b2b_partnership')
    expect(result?.category).toBe('sensitive')
  })

  it('escalates on refund keyword even without complaint classifier', () => {
    const result = detectForcedEscalation(
      "I'd like a refund on the booking from last week.",
      'cancellation_request'
    )
    expect(result?.trigger).toBe('refund')
    expect(result?.customerFacingMessage).not.toMatch(/sorry/i)
  })

  it('escalates on custom-request language', () => {
    const result = detectForcedEscalation(
      'Looking for a private charter with a custom itinerary for our family',
      'booking_inquiry'
    )
    expect(result?.trigger).toBe('custom_request')
    expect(result?.routeTo).toBe('owner')
  })

  it('returns null for ordinary booking inquiry', () => {
    const result = detectForcedEscalation(
      'Can I book the North Bimini Heritage tour for Saturday?',
      'booking_inquiry'
    )
    expect(result).toBeNull()
  })

  it('returns null for gratitude', () => {
    const result = detectForcedEscalation('Thanks so much for the great trip!', 'gratitude')
    expect(result).toBeNull()
  })

  it('complaint classifier outranks refund keyword for empathy template', () => {
    // Both fire — complaint priority wins so the customer gets the empathy
    // line, not the neutral refund line.
    const result = detectForcedEscalation(
      'absolutely disappointed, we want a refund',
      'complaint'
    )
    expect(result?.trigger).toBe('complaint')
    expect(result?.customerFacingMessage).toMatch(/sorry/i)
  })

  it('does not fire on "cancellation policy" reference without other triggers', () => {
    const result = detectForcedEscalation(
      'What is your cancellation policy?',
      'general_question'
    )
    expect(result).toBeNull()
  })

  it('does not fire refund trigger on a plain refund-policy question', () => {
    // Regression: Karin Roberts thread (2026-08-06) — bare "refund" in a policy
    // question ("is a refund offered when the port stop is cancelled?") used to
    // match REFUND_PATTERN even with no request/demand shape to it.
    const result = detectForcedEscalation(
      "I'm curious if a refund is offered when the port stop is cancelled?",
      'general_question'
    )
    expect(result).toBeNull()
  })

  it('appends a customer recap to the locked template for a web-form submission', () => {
    // Regression for the Robert booking (2026-08-06): a custom-request
    // trigger firing on a Web3Forms submission used to send the customer
    // ONLY the locked stem ("Thanks for the details...") with no sign any
    // of their nine form fields were actually read.
    const body = [
      'Name: Robert',
      'Email: robert@example.com',
      'Phone: 5551234567',
      'Guests: 5',
      'Date: Monday, August 31, 2026',
      'DateISO: 2026-08-31',
      'Tour: Private VIP Custom Tour',
      'Notes: Traveling with my mother who is limited in walking.',
    ].join('\n')
    const result = detectForcedEscalation(body, 'booking_inquiry')
    expect(result?.trigger).toBe('custom_request')
    // Locked stem still present, unedited.
    expect(result?.customerFacingMessage).toMatch(/Thanks for the details/)
    // Plus the deterministic recap, quoting the note verbatim.
    expect(result?.customerFacingMessage).toContain('Monday, August 31')
    expect(result?.customerFacingMessage).toContain('limited in walking')
  })

  it('leaves the locked template untouched for ordinary prose (no recap to add)', () => {
    const result = detectForcedEscalation(
      'Looking for a private charter with a custom itinerary for our family',
      'booking_inquiry'
    )
    expect(result?.customerFacingMessage).toBe(
      "Thanks for the details — let me check on this with the team and circle back shortly."
    )
  })

  it('escalates on a Full Bimini Experience intake-form submission', () => {
    // Regression: Emily Sherman thread (2026-08-08) — Caye quoted pricing and
    // offered to hold the date herself on this package instead of tossing it
    // to Mrs. Max, despite the founder confirming (2026-08-06) it should
    // always escalate regardless of what Caye would otherwise auto-approve.
    const body = [
      'Name: Emily Sherman',
      'Email: emily@eventblissdesign.com',
      'Guests: 3',
      'Date: Thursday, August 20, 2026',
      'Tour: Full Bimini Experience',
      'Notes: Would love a guided golf cart tour of the north and South Island. Thanks!',
    ].join('\n')
    const result = detectForcedEscalation(body, 'booking_inquiry')
    expect(result?.trigger).toBe('full_bimini_experience')
    expect(result?.routeTo).toBe('owner')
  })

  it('escalates on a conversational mention of the Full Bimini Experience', () => {
    const result = detectForcedEscalation(
      "Hi, we're interested in the full bimini experience for our trip next month",
      'booking_inquiry'
    )
    expect(result?.trigger).toBe('full_bimini_experience')
  })

  it('does not fire the Full Bimini Experience trigger for other tours', () => {
    const result = detectForcedEscalation(
      'Can I book the North Bimini Heritage tour for Saturday?',
      'booking_inquiry'
    )
    expect(result).toBeNull()
  })

  it('pingSummary is plain-language, not internal classifier jargon', () => {
    // Regression test: pingSummary is what ends up in the operator's WhatsApp
    // ping. internalContext ("Forced escalation — b2b_partnership (inbound
    // classifier — ...)") is dashboard-only debug text and must never leak
    // into pingSummary or the customer/operator-facing channel.
    const result = detectForcedEscalation(
      'Reaching out from XYZ DMC about wholesale rates',
      'b2b_partnership'
    )
    expect(result?.pingSummary).toBeTruthy()
    expect(result?.pingSummary).not.toMatch(/forced escalation/i)
    expect(result?.pingSummary).not.toMatch(/inbound classifier/i)
    expect(result?.pingSummary).not.toContain(result?.trigger)
  })
})
