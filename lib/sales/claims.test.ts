import { describe, it, expect } from 'vitest'
import { findClaimIssues } from './claims'
import { CAYE_STANDARD_MONTHLY_PRICE_USD, SALES_FACTS } from './facts'

function kinds(text: string) {
  return findClaimIssues(text).map((i) => i.kind)
}

describe('findClaimIssues', () => {
  it('uses the one published standard-price authority', () => {
    expect(CAYE_STANDARD_MONTHLY_PRICE_USD).toBe(99)
    expect(SALES_FACTS.monthlyPriceUsd).toBe(CAYE_STANDARD_MONTHLY_PRICE_USD)
  })

  it('passes a clean, truthful draft', () => {
    const good =
      "Hey Marcus, running Blue Water Charters means messages come in while you're on the boat. " +
      "I'm Lamar, founder of TropiTech, a Bahamian tech company. I built Caye. She lives in WhatsApp, " +
      "making sure every customer gets a reply before they give up. She's $99/month. Want to see it? " +
      'https://www.meetcaye.com/api/r/abc123 Lamar'
    expect(findClaimIssues(good)).toEqual([])
  })

  it('rejects an invented price', () => {
    expect(kinds('It is $49/month for the first year.')).toContain('unverified_price')
    expect(kinds('Normally $199, but for you $79.')).toContain('unverified_price')
  })

  it('accepts the real price in any reasonable format', () => {
    expect(kinds('It is $99 a month.')).not.toContain('unverified_price')
    expect(kinds('$99.00 flat.')).not.toContain('unverified_price')
    expect(kinds('It is $79 a month.')).toContain('unverified_price')
  })

  it('rejects customers we cannot name', () => {
    expect(kinds('Businesses like Atlantis and Sandals already use her.')).toContain(
      'unnameable_customer'
    )
  })

  it('allows the one real proof point', () => {
    expect(kinds('Businesses like Bimini Island Tours already use her.')).not.toContain(
      'unnameable_customer'
    )
  })

  it('rejects fabricated scale', () => {
    expect(kinds('Hundreds of businesses in the Bahamas use Caye.')).toContain('fabricated_scale')
    expect(kinds('Over 200 customers trust her.')).toContain('fabricated_scale')
  })

  it('rejects commitments Caye cannot authorise', () => {
    expect(kinds('I can give you 50% off for three months.')).toContain('unauthorised_commitment')
    expect(kinds('We offer a money back guarantee.')).toContain('unauthorised_commitment')
    expect(kinds('Happy to do a custom plan for you.')).toContain('unauthorised_commitment')
  })

  it('rejects integrations that do not exist', () => {
    expect(kinds('She integrates with QuickBooks.')).toContain('unsupported_integration')
    expect(kinds('Caye syncs with Stripe automatically.')).toContain('unsupported_integration')
  })

  it('allows channels that genuinely work', () => {
    expect(kinds('She works with WhatsApp and Instagram.')).not.toContain('unsupported_integration')
  })

  it('rejects capabilities that are not built', () => {
    expect(kinds('She can answer your phone calls too.')).toContain('nonexistent_capability')
  })

  it('allows honestly saying a capability does not exist', () => {
    // "No, not yet" must stay sayable, or Caye cannot answer honestly.
    const honest = 'She does not do phone answering yet, just WhatsApp and email.'
    expect(kinds(honest)).not.toContain('nonexistent_capability')
  })
})
