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
