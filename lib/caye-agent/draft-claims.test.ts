import { describe, it, expect } from 'vitest'
import {
  extractDollarAmounts,
  amountsAttestedBy,
  assertsAvailability,
  withoutAvailabilityClaims,
} from './draft-claims'

describe('extractDollarAmounts', () => {
  it('canonicalises so $199.00 and $199 are the same figure', () => {
    expect(extractDollarAmounts('It is $199.00 total')).toEqual(['199'])
    expect(extractDollarAmounts('$1,200 per group')).toEqual(['1200'])
  })

  it('finds every distinct figure', () => {
    expect(extractDollarAmounts('$150 each, $600 for the group')).toEqual(['150', '600'])
  })

  it('finds nothing in a draft with no figures', () => {
    expect(extractDollarAmounts('We open at nine.')).toEqual([])
  })
})

describe('amountsAttestedBy', () => {
  const corpus = 'North Bimini Heritage Tour — $150 per person. Private charter $600.'

  it('passes a figure that came out of the retrieved pricing', () => {
    expect(amountsAttestedBy(['150'], corpus)).toBe(true)
    expect(amountsAttestedBy(['150', '600'], corpus)).toBe(true)
  })

  it('catches an invented figure', () => {
    // The Karin Roberts case: "$99.50" existed nowhere in the workspace.
    expect(amountsAttestedBy(['99.5'], corpus)).toBe(false)
  })

  it('catches a partly-invented quote', () => {
    expect(amountsAttestedBy(['150', '275'], corpus)).toBe(false)
  })

  it('treats a draft with no figures as attested', () => {
    // Nothing asserted, nothing to ground.
    expect(amountsAttestedBy([], corpus)).toBe(true)
  })

  it('matches a bare numeral in the corpus against a $-prefixed draft figure', () => {
    // The services list renders prices without a $ sign.
    expect(amountsAttestedBy(['150'], 'Heritage Tour, 150, 120 minutes')).toBe(true)
  })
})

describe('assertsAvailability', () => {
  it('catches a direct commitment', () => {
    expect(assertsAvailability('Yes, the 20th is available.')).toBe(true)
    expect(assertsAvailability('We have space on Thursday morning.')).toBe(true)
    expect(assertsAvailability('We can fit you in at 10am.')).toBe(true)
    expect(assertsAvailability('That date works for us.')).toBe(true)
  })

  it('does NOT fire on a promise to check', () => {
    // False positives here hold replies that should have shipped. The brief
    // is explicit that Caye must not be made less capable to feel safer.
    expect(assertsAvailability('Let me check if the 20th is available.')).toBe(false)
    expect(assertsAvailability("I'll confirm whether we have space and come back to you.")).toBe(false)
    expect(assertsAvailability('Let me see if that works and get back to you.')).toBe(false)
  })

  it('does NOT fire on ordinary conversation', () => {
    expect(assertsAvailability('Thanks for reaching out! What date were you thinking?')).toBe(false)
    expect(assertsAvailability('The tour runs about two hours.')).toBe(false)
  })

  it('does NOT fire on stable business knowledge that mentions "shared"/tour options', () => {
    // A definition or a catalog listing is not an availability claim just
    // because the conversation concerns a tour (brief item 5).
    expect(
      assertsAvailability(
        'A shared tour means other guests may also be on it, while a private tour is just your group.'
      )
    ).toBe(false)
    expect(
      assertsAvailability('We also offer the North Bimini Heritage Tour, a shared or private option.')
    ).toBe(false)
  })

  it('is sentence-scoped, so a hedge cannot excuse a separate commitment', () => {
    // The first clause is still a promise the customer will act on.
    expect(
      assertsAvailability('The 20th is available. Let me confirm the boat and come back to you.')
    ).toBe(true)
  })

  it('accepts a hedge in the same sentence as neutralising', () => {
    expect(assertsAvailability('I think the 20th is available, but let me confirm.')).toBe(false)
  })
})

describe('withoutAvailabilityClaims', () => {
  it('keeps grounded content and drops only the unverified claim (Pam Ott shape)', () => {
    const draft =
      'A shared tour means other guests may join yours, while a private tour is just your ' +
      'group. We also offer the North Bimini Heritage Tour. We have space for a few more on ' +
      'that date.'
    const result = withoutAvailabilityClaims(draft)
    expect(result).toContain('A shared tour means other guests may join yours')
    expect(result).toContain('North Bimini Heritage Tour')
    expect(result).not.toContain('We have space for a few more')
  })

  it('leaves a draft with no availability claim untouched', () => {
    const draft = 'A shared tour means other guests may join yours on the same trip.'
    expect(withoutAvailabilityClaims(draft)).toBe(draft)
  })

  it('keeps a hedged sentence — it never asserted anything to strip', () => {
    const draft = 'Let me check if the 20th is available and come back to you.'
    expect(withoutAvailabilityClaims(draft)).toBe(draft)
  })

  it('returns empty when the entire draft was the unverified claim', () => {
    expect(withoutAvailabilityClaims('Yes, we have space for 8 on the 20th.')).toBe('')
  })

  it('preserves order and drops multiple unverified sentences', () => {
    const draft = 'That date works for us. Prices start at $110 per person. We can fit your group in.'
    const result = withoutAvailabilityClaims(draft)
    expect(result).toBe('Prices start at $110 per person.')
  })
})
