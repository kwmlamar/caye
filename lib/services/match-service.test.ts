import { describe, it, expect } from 'vitest'
import {
  matchServiceByName,
  extractCustomerTourName,
  buildMatchHintBlock,
  type CandidateService,
} from './match-service'

// Bimini's actual service catalog as of 2026-06-05. These tests use the
// real-world name strings so regressions surface as concrete miscalls.
const BIMINI_SERVICES: CandidateService[] = [
  { id: 'svc-full',    name: 'Full Bimini Experience' },
  { id: 'svc-heritage',name: 'North Bimini Heritage Tour' },
  { id: 'svc-ponce',   name: 'South Bimini: Ponce de Leon Tour' },
  { id: 'svc-eat',     name: 'Eat Like a Local: Bimini Food Experience' },
  { id: 'svc-sitlow',  name: 'Bimini Sit-Low Sightseeing' },
  { id: 'svc-golf',    name: 'Golf Cart Guided Tour' },
]

describe('matchServiceByName', () => {
  it('returns confidence "none" for empty inputs', () => {
    expect(matchServiceByName(BIMINI_SERVICES, '').confidence).toBe('none')
    expect(matchServiceByName([], 'Heritage Tour').confidence).toBe('none')
    expect(matchServiceByName(BIMINI_SERVICES, '   ').confidence).toBe('none')
  })

  // The Jeff Montenaro / James Stallings regression case.
  it('matches "North Bimini Historical Tour" → Heritage Tour with high confidence', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'North Bimini Historical Tour')
    expect(r.best?.id).toBe('svc-heritage')
    expect(r.confidence).toBe('high')
  })

  it('matches "Heritage Tour" → Heritage Tour exactly, high confidence', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'Heritage Tour')
    expect(r.best?.id).toBe('svc-heritage')
    expect(r.confidence).toBe('high')
  })

  it('matches "Golf Cart Guided Tour" → Golf Cart, high confidence', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'Golf Cart Guided Tour')
    expect(r.best?.id).toBe('svc-golf')
    expect(r.confidence).toBe('high')
  })

  it('matches "the food tour" → Eat Like a Local via synonym', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'Food Tour')
    expect(r.best?.id).toBe('svc-eat')
    expect(r.confidence === 'high' || r.confidence === 'medium').toBe(true)
  })

  it('matches "Sit Low" → Sit-Low Sightseeing', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'Sit Low')
    expect(r.best?.id).toBe('svc-sitlow')
  })

  it('matches "Fountain of Youth" → Ponce de Leon via synonym', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'Fountain of Youth Tour')
    expect(r.best?.id).toBe('svc-ponce')
  })

  it('returns top candidates ordered by score', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'Bimini Tour')
    expect(r.candidates.length).toBeGreaterThan(0)
    expect(r.candidates.length).toBeLessThanOrEqual(3)
    // Scores monotonically decreasing
    for (let i = 1; i < r.candidates.length; i++) {
      expect(r.candidates[i].score).toBeLessThanOrEqual(r.candidates[i - 1].score)
    }
  })

  it('handles totally off-catalog input without throwing', () => {
    const r = matchServiceByName(BIMINI_SERVICES, 'Snorkel and Sushi Combo')
    expect(['low', 'none', 'medium']).toContain(r.confidence)
    // Should not crash; should not return high confidence on unrelated input.
    expect(r.confidence).not.toBe('high')
  })

  it('respects custom thresholds', () => {
    // Score for "North Bimini Historical Tour" → "North Bimini Heritage Tour"
    // is ~1.0 + substring bonus 0.15 = ~1.15. Push thresholds above that to
    // force 'low' even though tokens align cleanly.
    const r = matchServiceByName(
      BIMINI_SERVICES,
      'North Bimini Historical Tour',
      { highThreshold: 1.5, mediumThreshold: 1.5 }
    )
    expect(r.confidence).toBe('low')
    expect(r.best?.id).toBe('svc-heritage') // best is still returned
  })
})

describe('extractCustomerTourName', () => {
  it('extracts from intake-form Tour: line', () => {
    const body = [
      'Name: Jeff A Montenaro',
      'Email: jam43065@aol.com',
      'Guests: 4',
      'Tour: Golf Cart Guided Tour',
    ].join('\n')
    expect(extractCustomerTourName(body)).toBe('Golf Cart Guided Tour')
  })

  it('strips trailing punctuation from intake field', () => {
    expect(extractCustomerTourName('Tour: Heritage Tour.')).toBe('Heritage Tour')
  })

  it('extracts free-text "the X tour" patterns', () => {
    const body = "Hi, we'd like to book the Heritage Tour for two on June 11."
    expect(extractCustomerTourName(body)).toBe('Heritage')
  })

  it('returns null when no tour reference', () => {
    expect(extractCustomerTourName('Hi, do you have availability?')).toBeNull()
    expect(extractCustomerTourName('')).toBeNull()
  })

  it('ignores lowercase noun phrases (avoid false positives)', () => {
    // "the food was great" should not match.
    expect(extractCustomerTourName('the food was great on our tour')).toBeNull()
  })

  it('prefers the intake-form field when both are present', () => {
    const body = [
      'Tour: Eat Like a Local',
      'Notes: we want the heritage tour too',
    ].join('\n')
    expect(extractCustomerTourName(body)).toBe('Eat Like a Local')
  })
})

describe('buildMatchHintBlock', () => {
  it('returns empty string when no match', () => {
    expect(
      buildMatchHintBlock({ query: '', best: null, confidence: 'none', candidates: [] })
    ).toBe('')
  })

  it('produces a HIGH CONFIDENCE block when confident', () => {
    const block = buildMatchHintBlock({
      query: 'Historical Tour',
      best: { id: 'svc-heritage', name: 'North Bimini Heritage Tour' },
      confidence: 'high',
      candidates: [
        { service: { id: 'svc-heritage', name: 'North Bimini Heritage Tour' }, score: 0.9 },
      ],
    })
    expect(block).toContain('HIGH CONFIDENCE')
    expect(block).toContain('svc-heritage')
    expect(block).toContain('Historical Tour')
    expect(block).toContain('lookup_price')
  })

  it('produces an AMBIGUOUS block listing candidates when not high', () => {
    const block = buildMatchHintBlock({
      query: 'Bimini Tour',
      best: { id: 'svc-full', name: 'Full Bimini Experience' },
      confidence: 'medium',
      candidates: [
        { service: { id: 'svc-full', name: 'Full Bimini Experience' }, score: 0.4 },
        { service: { id: 'svc-heritage', name: 'North Bimini Heritage Tour' }, score: 0.35 },
      ],
    })
    expect(block).toContain('AMBIGUOUS')
    expect(block).toContain('Full Bimini Experience')
    expect(block).toContain('North Bimini Heritage Tour')
    expect(block).toContain('CLARIFY')
  })
})
