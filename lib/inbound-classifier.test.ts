import { describe, it, expect } from 'vitest'
import { classifyInbound, toneHintFor } from './inbound-classifier'

describe('classifyInbound', () => {
  it('detects complaints as the dominant signal even when other keywords appear', () => {
    const result = classifyInbound(
      'I am extremely disappointed with our tour yesterday — the guide was rude and unprofessional. I want a refund.',
      'Unhappy with my booking'
    )
    expect(result.category).toBe('complaint')
  })

  it('detects cancellation requests', () => {
    expect(classifyInbound('Hi, we need to cancel our Saturday booking.').category).toBe('cancellation_request')
    expect(classifyInbound("Sorry I can't make it on the 15th anymore.").category).toBe('cancellation_request')
  })

  it('does NOT misclassify "cancellation policy" question as a cancel request', () => {
    // The customer is asking about the policy, not actually cancelling.
    const result = classifyInbound('What is your cancellation policy?')
    expect(result.category).not.toBe('cancellation_request')
  })

  it('detects rescheduling requests', () => {
    expect(classifyInbound('Can we reschedule our tour to next weekend?').category).toBe('rescheduling')
    expect(classifyInbound('Need to change the date — Saturday is no longer good.').category).toBe('rescheduling')
  })

  it('classifies a short thank-you message as gratitude', () => {
    expect(classifyInbound('Thanks so much, see you Saturday!').category).toBe('gratitude')
    expect(classifyInbound('Perfect, much appreciated.').category).toBe('gratitude')
  })

  it('does NOT classify a long "thanks but also asking something" message as pure gratitude', () => {
    const result = classifyInbound(
      'Thanks for the info! One quick question though — can you accommodate dietary restrictions on the food tour? My partner is vegetarian and we want to make sure that works.'
    )
    expect(result.category).not.toBe('gratitude')
  })

  it('does NOT classify thanks-with-a-question as gratitude', () => {
    const result = classifyInbound('Thanks! What time should we be at the dock?')
    expect(result.category).not.toBe('gratitude')
  })

  it('detects new-booking inquiries', () => {
    expect(classifyInbound('Hi! Do you have availability for the Full Bimini tour on June 10?').category).toBe('booking_inquiry')
    expect(classifyInbound("We'd like to book 4 spots for next Friday.").category).toBe('booking_inquiry')
  })

  it('falls back to general_question when a question mark is present without other signals', () => {
    expect(classifyInbound('What kind of shoes should we wear?').category).toBe('general_question')
  })

  it('returns null when nothing matches confidently', () => {
    // No keywords, no question marks — Caye uses default tone.
    expect(classifyInbound('See you tomorrow.').category).toBeNull()
  })

  it('prioritises complaint over other categories when both match', () => {
    // "cancel my booking" + "disappointed" → complaint should win on priority
    const result = classifyInbound(
      'I am so disappointed with the service. Please cancel my booking immediately and refund me.'
    )
    expect(result.category).toBe('complaint')
  })
})

describe('toneHintFor', () => {
  it('returns empty string for null category (no prompt noise)', () => {
    expect(toneHintFor(null)).toBe('')
  })

  it('returns an empathetic hint for complaints', () => {
    const hint = toneHintFor('complaint')
    expect(hint.toLowerCase()).toContain('empathy')
    expect(hint.toLowerCase()).toContain('do not be defensive')
  })

  it('tells Caye not to upsell on cancellations', () => {
    const hint = toneHintFor('cancellation_request')
    expect(hint.toLowerCase()).toContain('do not try to talk them out')
  })

  it('routes rescheduling hints to the reschedule_booking tool', () => {
    const hint = toneHintFor('rescheduling')
    expect(hint).toContain('reschedule_booking')
  })

  it('tells Caye to stay brief on gratitude', () => {
    const hint = toneHintFor('gratitude')
    expect(hint.toLowerCase()).toContain('briefly')
    expect(hint.toLowerCase()).toContain("don't over-extend")
  })
})
