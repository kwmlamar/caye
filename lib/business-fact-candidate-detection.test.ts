import { describe, it, expect } from 'vitest'
import {
  extractCandidateSentences,
  isCandidateSentence,
  normalizeSentence,
  guessCategory,
  shouldProposeCandidate,
  OCCURRENCE_THRESHOLD,
} from './business-fact-candidate-detection'

// Real sentences pulled from the Bridgette Jones / Bimini conversation
// (2026-07-04/05) and the surrounding conversation history that motivated
// this feature — Max retyped these across 15+ conversations by hand.
const PICKUP_SENTENCE =
  'Casino Tram Stop at the Hilton Resorts World is the pick-up point'
const GUIDE_SENTENCE =
  "Please remain on the tram until you reach the Casino Tram Stop, where your guide, James Edden, will be waiting to greet you."

describe('extractCandidateSentences / isCandidateSentence', () => {
  it('picks up stable logistics info (pickup point)', () => {
    expect(isCandidateSentence(PICKUP_SENTENCE)).toBe(true)
  })

  it('excludes sentences that name a specific guide (rotates per booking)', () => {
    expect(isCandidateSentence(GUIDE_SENTENCE)).toBe(false)
  })

  it('excludes short acks and greetings', () => {
    expect(isCandidateSentence('Thanks!')).toBe(false)
    expect(isCandidateSentence('Good evening,')).toBe(false)
  })

  it('extracts only the stable sentence out of a full confirmation message', () => {
    const message =
      `Hello,\n\nThank you for your payment. We are pleased to confirm your tour.\n\n` +
      `${PICKUP_SENTENCE}.\n\n${GUIDE_SENTENCE}\n\nJames Edden: 242-473-0233`
    const candidates = extractCandidateSentences(message)
    expect(candidates.some(s => s.includes('Casino Tram Stop'))).toBe(true)
    expect(candidates.some(s => s.includes('James Edden'))).toBe(false)
  })
})

describe('normalizeSentence', () => {
  it('collapses punctuation/whitespace variance so near-identical retypes match', () => {
    const a = normalizeSentence('Casino Tram Stop at the Hilton Resorts World is the pick-up point.')
    const b = normalizeSentence('Casino Tram Stop at the Hilton Resorts World is the pick-up point')
    expect(a).toBe(b)
  })

  it('does not collapse genuinely different sentences', () => {
    const a = normalizeSentence(PICKUP_SENTENCE)
    const b = normalizeSentence('We meet you at Radio Beach for the sunset tour.')
    expect(a).not.toBe(b)
  })
})

describe('guessCategory', () => {
  it('guesses logistics for pickup/contact info', () => {
    expect(guessCategory(PICKUP_SENTENCE)).toBe('logistics')
  })

  it('guesses policy for cancellation/refund language', () => {
    expect(
      guessCategory('Refunds will be processed within 7-30 days using the original payment method.')
    ).toBe('policy')
  })
})

describe('shouldProposeCandidate', () => {
  it('does not propose below the occurrence threshold', () => {
    expect(shouldProposeCandidate('pending', OCCURRENCE_THRESHOLD - 1)).toBe(false)
  })

  it('proposes once the threshold is hit while still pending', () => {
    expect(shouldProposeCandidate('pending', OCCURRENCE_THRESHOLD)).toBe(true)
  })

  it('does not re-propose once already proposed', () => {
    expect(shouldProposeCandidate('proposed', OCCURRENCE_THRESHOLD + 5)).toBe(false)
  })
})
