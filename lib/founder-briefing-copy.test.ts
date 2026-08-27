import { describe, it, expect } from 'vitest'
import { buildBriefingLine } from './founder-briefing-copy'

describe('buildBriefingLine', () => {
  it('returns null when there is nothing to say', () => {
    expect(buildBriefingLine({
      bookingsCount: 0, customersAnswered: 0, primaryAttentionName: null, additionalAttentionCount: 0,
    })).toBeNull()
  })

  it('combines customers-answered and bookings when both present', () => {
    expect(buildBriefingLine({
      bookingsCount: 2, customersAnswered: 11, primaryAttentionName: null, additionalAttentionCount: 0,
    })).toBe('Morning. I handled 11 customers today and you have 2 bookings this week.')
  })

  it('singularizes counts of 1', () => {
    expect(buildBriefingLine({
      bookingsCount: 1, customersAnswered: 1, primaryAttentionName: null, additionalAttentionCount: 0,
    })).toBe('Morning. I handled 1 customer today and you have 1 booking this week.')
  })

  it('appends the single attention item as "the only thing"', () => {
    expect(buildBriefingLine({
      bookingsCount: 2, customersAnswered: 11, primaryAttentionName: 'Jonathan', additionalAttentionCount: 0,
    })).toBe('Morning. I handled 11 customers today and you have 2 bookings this week. Jonathan is the only thing that actually needs you.')
  })

  it('appends multiple attention items with a count', () => {
    expect(buildBriefingLine({
      bookingsCount: 0, customersAnswered: 0, primaryAttentionName: 'Jonathan', additionalAttentionCount: 2,
    })).toBe('Morning. Jonathan and 2 others need you.')
  })

  it('handles a single additional item (singular "other")', () => {
    expect(buildBriefingLine({
      bookingsCount: 0, customersAnswered: 0, primaryAttentionName: 'Jonathan', additionalAttentionCount: 1,
    })).toBe('Morning. Jonathan and 1 other need you.')
  })

  it('falls back to a bare greeting when only an attention item exists but no facts', () => {
    expect(buildBriefingLine({
      bookingsCount: 0, customersAnswered: 0, primaryAttentionName: 'Jonathan', additionalAttentionCount: 0,
    })).toBe('Morning. Jonathan is the only thing that actually needs you.')
  })
})
