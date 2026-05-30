import { describe, it, expect } from 'vitest'
import { resolveTier, type PricingTier } from './resolve-tier'

/**
 * Test fixture mirrors the real Bimini "North Bimini Heritage Tour" seeded
 * in supabase/migrations/20260530_service_pricing_tiers.sql — the exact tour
 * that broke in the Stallings 2026-05-29 case.
 */
const NORTH_BIMINI_TIERS: PricingTier[] = [
  {
    id: 't-adult',
    tier_name: 'Adult',
    group_size_min: 1,
    group_size_max: 1,
    price_amount: 110,
    price_label: '$110/person',
    is_flat: false,
    is_ambiguous_above: false,
    display_order: 10,
  },
  {
    id: 't-private-2',
    tier_name: 'Private (2 max)',
    group_size_min: 2,
    group_size_max: 2,
    price_amount: 375,
    price_label: '$375 flat (2 people max)',
    is_flat: true,
    is_ambiguous_above: false,
    display_order: 20,
  },
  {
    id: 't-private-group',
    tier_name: 'Private Group (min 4)',
    group_size_min: 4,
    group_size_max: 50,
    price_amount: 150,
    price_label: '$150/person',
    is_flat: false,
    is_ambiguous_above: false,
    display_order: 30,
  },
]

describe('resolveTier — North Bimini Heritage Tour (Stallings regression suite)', () => {
  it('1 person → Adult $110/person, $110 total', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.tier_name).toBe('Adult')
    expect(r.priceLabel).toBe('$110/person')
    expect(r.totalAmount).toBe(110)
    expect(r.totalLabel).toBe('$110 total')
  })

  it('2 people → Private (2 max) $375 flat — THE STALLINGS CASE', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 2)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.tier_name).toBe('Private (2 max)')
    expect(r.priceLabel).toBe('$375 flat (2 people max)')
    expect(r.totalAmount).toBe(375) // NOT 300 (which is the bug we're regressing)
    expect(r.totalLabel).toBe('$375 total')
  })

  it('3 people → HOLD (gap between Private 2-max and Private Group 4-min)', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 3)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('group_size_in_gap_between_tiers')
    expect(r.candidateTiers).toHaveLength(3)
    expect(r.message).toMatch(/gap/)
  })

  it('4 people → Private Group $150/person, $600 total', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 4)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.tier_name).toBe('Private Group (min 4)')
    expect(r.totalAmount).toBe(600)
  })

  it('10 people → Private Group $150/person, $1500 total', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 10)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totalAmount).toBe(1500)
  })

  it('51 people → HOLD (above highest tier max of 50)', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 51)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('group_size_above_maximum')
  })

  it('0 people → HOLD (below minimum)', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 0)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('group_size_below_minimum')
  })

  it('negative → HOLD (invalid)', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, -5)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('group_size_below_minimum')
  })

  it('non-integer → HOLD (invalid)', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 2.5)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('group_size_below_minimum')
  })
})

describe('resolveTier — empty / edge config', () => {
  it('no tiers configured → HOLD with no_tiers_configured', () => {
    const r = resolveTier([], 2)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('no_tiers_configured')
  })

  it('overlapping tiers (operator misconfiguration) → HOLD with multiple_tiers_matched', () => {
    const overlapping: PricingTier[] = [
      { ...NORTH_BIMINI_TIERS[0], group_size_max: 5 }, // Adult now covers 1-5
      { ...NORTH_BIMINI_TIERS[2], group_size_min: 3 }, // Private Group now covers 3-50
    ]
    const r = resolveTier(overlapping, 4) // 4 matches both
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('multiple_tiers_matched')
    expect(r.candidateTiers).toHaveLength(2)
  })
})

describe('resolveTier — ambiguous-above tiers (e.g. "starting at $X")', () => {
  const GOLF_CART_TIERS: PricingTier[] = [
    {
      id: 'gc-orient',
      tier_name: 'Orientation (1hr)',
      group_size_min: 1,
      group_size_max: 4,
      price_amount: 199,
      price_label: 'Starting at $199 (1-hour orientation)',
      is_flat: true,
      is_ambiguous_above: true,
      display_order: 10,
    },
  ]

  it('matches but holds because is_ambiguous_above=true', () => {
    const r = resolveTier(GOLF_CART_TIERS, 2)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('tier_explicitly_ambiguous_above')
    expect(r.message).toMatch(/starting at/i)
  })

  it('above tier max → above_maximum hold, not ambiguous_above', () => {
    const r = resolveTier(GOLF_CART_TIERS, 10)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('group_size_above_maximum')
  })
})

describe('resolveTier — flat vs per-person totals', () => {
  it('flat tier: total = price_amount regardless of group size', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 2) // Private 2-max is flat
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.is_flat).toBe(true)
    expect(r.totalAmount).toBe(375) // not 750 (375 × 2)
  })

  it('per-person tier: total = price_amount × group_size', () => {
    const r = resolveTier(NORTH_BIMINI_TIERS, 6) // Private Group, per-person
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.is_flat).toBe(false)
    expect(r.totalAmount).toBe(900) // 150 × 6
  })
})
