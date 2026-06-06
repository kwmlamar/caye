/**
 * Regression tests for cold-sales detection. The detector itself is colocated
 * in app/api/email/poll/route.ts; these tests verify the patterns it uses
 * keep working as expected. We test the regexes directly here rather than
 * importing the route handler (which has its own runtime dependencies).
 */

import { describe, it, expect } from 'vitest'

const COLD_SALES_TOOL_DOMAINS = /\b(apollo\.io|outreach\.io|salesloft\.com|salesloft\.io|mixmax\.com|hunter\.io|reply\.io|woodpecker\.co|lemlist\.com|mailshake\.com|saleshandy\.com|smartlead\.ai|instantly\.ai)\b/

const COLD_SALES_BODY_PHRASES: RegExp[] = [
  /\b(calendly\.com|cal\.com)\//i,
  /\b(15|20|25|30)[-\s]?(min|minute)s?\b.{0,40}\b(chat|call|demo|conversation|sync)\b/i,
  /book\s+(?:a\s+)?(?:quick\s+)?(?:time|call|chat|demo|meeting|slot)\b/i,
  /\b(i|we)\s+help\s+(tour|small|local|caribbean)?\s*(operators?|businesses?|companies?|owners?|founders?)\b/i,
  /\b(grow|scale|increase|boost|double|10x|optimi[sz]e)\s+your\s+(bookings?|revenue|business|sales|leads?)\b/i,
  /\b(saw|came across|noticed|stumbled (?:on|upon))\s+(?:your\s+)?(website|business|company|tours?|page)\b/i,
  /\bquick\s+(intro|question|favor|ask)\b/i,
  /worth\s+(?:a\s+)?(?:quick\s+)?(?:15|20|30)?\s*(?:min(?:ute)?s?\s+)?chat\b/i,
  /\b(ai|chatbot|automation|saas|crm)\s+for\s+(tour|small|local)\s+(operators?|businesses?|companies?)\b/i,
]

function countPhraseHits(body: string): number {
  let hits = 0
  for (const re of COLD_SALES_BODY_PHRASES) if (re.test(body)) hits++
  return hits
}

describe('cold sales pattern detection', () => {
  // The single most important regression case.
  it('does NOT flag the Anastasiya / Virgin Voyages partnership email', () => {
    const body = [
      'Hello Karenda,',
      '',
      'Thank you very much for your email, and we are truly excited to hear that Virgin Voyages is interested in the Bimini program. We appreciate the opportunity to continue working together in developing an experience that is enjoyable, accessible, and operationally realistic for both guests and guides.',
      '',
      'After reviewing the proposed itinerary, I would agree that the current 3-hour timing may feel somewhat tight, particularly for guests with accessibility needs.',
      '',
      'Warm regards,',
      'Anastasiya Lisouskaya',
      'Cruise Partnership Lead',
      'Accessible Travel Solutions, LLC',
    ].join('\n')
    expect(countPhraseHits(body)).toBe(0)
  })

  it('does NOT flag a guest booking inquiry that mentions "your website"', () => {
    // Booking inquiries often say "I saw your website" — this is the most
    // ambiguous false-positive risk. Single phrase hit is below threshold (2).
    const body =
      "Hi! I saw your website and we'd love to book the Heritage Tour for 2 adults on June 11."
    expect(countPhraseHits(body)).toBe(1)
  })

  it('flags a classic "I help tour operators" pitch (2+ phrases)', () => {
    const body =
      "Hi, I help tour operators grow their bookings with AI. Worth a 15-min chat?"
    expect(countPhraseHits(body)).toBeGreaterThanOrEqual(2)
  })

  it('flags a calendly + intro pitch', () => {
    const body =
      "Hi Karenda, quick intro — I noticed your tours page. Got 20 min? calendly.com/me/quick-chat"
    expect(countPhraseHits(body)).toBeGreaterThanOrEqual(2)
  })

  it('flags AI-for-tour-operators pitches (Kelsey Tonner style)', () => {
    const body =
      "Hi, I'm building AI for tour operators and would love to do a quick demo. Book a 30-min call here."
    expect(countPhraseHits(body)).toBeGreaterThanOrEqual(2)
  })

  it('flags known sales-tool sender domains directly', () => {
    expect(COLD_SALES_TOOL_DOMAINS.test('outreach.io')).toBe(true)
    expect(COLD_SALES_TOOL_DOMAINS.test('something.apollo.io')).toBe(true)
    expect(COLD_SALES_TOOL_DOMAINS.test('lemlist.com')).toBe(true)
    expect(COLD_SALES_TOOL_DOMAINS.test('tourbimini.com')).toBe(false)
    expect(COLD_SALES_TOOL_DOMAINS.test('gmail.com')).toBe(false)
  })

  it('does NOT flag the James Stallings genuine booking email', () => {
    const body =
      "Hello, Thank you for your email. We would like to book the private tour on June 11 for $150 per person. There will be two of us. The Celebrity website shows us docking at 8:00 a.m."
    // "book the private tour" matches the "book a ... tour" phrase? Let's see.
    const hits = countPhraseHits(body)
    expect(hits).toBeLessThanOrEqual(1)
  })

  it('does NOT flag the Marissa McGourthy genuine pricing question', () => {
    const body =
      "Hi there, One more question on your pricing for the Golf Cart tour. You state \"starting at $350\" but I'm curious how that number fluctuates? Is it a per person additional charge? Also how many people in total can fit on the Golf Cart?"
    expect(countPhraseHits(body)).toBe(0)
  })
})
