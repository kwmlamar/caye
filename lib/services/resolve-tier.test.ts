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

describe('resolveTier — variant axis (Karenda 2026-07-23 confirmed pricing)', () => {
  /**
   * North Bimini Heritage Tour under the new confirmed structure: at every
   * group size there are now TWO legitimate prices (Standard vs Private),
   * so group_size alone is ambiguous. Mirrors the shape landed in
   * supabase/migrations/20260726b_pricing_tier_variants.sql.
   */
  const HERITAGE_V2: PricingTier[] = [
    { id: 'h-std-1', tier_name: 'Standard — 1 Guest', variant: 'standard', group_size_min: 1, group_size_max: 1, price_amount: 110, price_label: '$110/person', is_flat: false, is_ambiguous_above: false, display_order: 10 },
    { id: 'h-priv-1', tier_name: 'Private — 1 Guest', variant: 'private', group_size_min: 1, group_size_max: 1, price_amount: 200, price_label: '$200 flat', is_flat: true, is_ambiguous_above: false, display_order: 20 },
    { id: 'h-std-2', tier_name: 'Standard — 2 Guests', variant: 'standard', group_size_min: 2, group_size_max: 2, price_amount: 220, price_label: '$220 total', is_flat: true, is_ambiguous_above: false, display_order: 30 },
    { id: 'h-priv-2', tier_name: 'Private — 2 Guests', variant: 'private', group_size_min: 2, group_size_max: 2, price_amount: 350, price_label: '$350 total', is_flat: true, is_ambiguous_above: false, display_order: 40 },
    { id: 'h-std-3', tier_name: 'Standard — 3+ Guests', variant: 'standard', group_size_min: 3, group_size_max: 50, price_amount: 110, price_label: '$110/person', is_flat: false, is_ambiguous_above: false, display_order: 50 },
    { id: 'h-priv-3', tier_name: 'Private — 3+ Guests', variant: 'private', group_size_min: 3, group_size_max: 50, price_amount: 150, price_label: '$150/person', is_flat: false, is_ambiguous_above: false, display_order: 60 },
  ]

  it('no variant supplied → HOLD multiple_tiers_matched, candidates carry variant labels', () => {
    const r = resolveTier(HERITAGE_V2, 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('multiple_tiers_matched')
    expect(r.candidateTiers.map(t => t.variant).sort()).toEqual(['private', 'standard'])
    expect(r.message).toMatch(/ask the customer/i)
  })

  it('variant="standard" at 1 guest → resolves to $110/person', () => {
    const r = resolveTier(HERITAGE_V2, 1, 'standard')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.tier_name).toBe('Standard — 1 Guest')
    expect(r.totalAmount).toBe(110)
  })

  it('variant="private" at 1 guest → resolves to $200 flat, not $110', () => {
    const r = resolveTier(HERITAGE_V2, 1, 'private')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.tier_name).toBe('Private — 1 Guest')
    expect(r.totalAmount).toBe(200)
  })

  it('variant="private" at 2 guests → $350 total flat, not 2x175', () => {
    const r = resolveTier(HERITAGE_V2, 2, 'private')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totalAmount).toBe(350)
  })

  it('variant="standard" at 6 guests → per-person $110 x 6 = $660', () => {
    const r = resolveTier(HERITAGE_V2, 6, 'standard')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.totalAmount).toBe(660)
  })

  it('unknown variant at a size that has options → HOLD variant_not_available', () => {
    const r = resolveTier(HERITAGE_V2, 1, 'vip')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hold).toBe('variant_not_available')
    expect(r.candidateTiers).toHaveLength(2)
  })

  it('variant supplied but group size only matches one tier → resolves normally (variant ignored)', () => {
    // Regression guard: tours without a variant axis must be unaffected by
    // a caller accidentally passing a variant string.
    const r = resolveTier(NORTH_BIMINI_TIERS, 2, 'private')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tier.tier_name).toBe('Private (2 max)')
    expect(r.totalAmount).toBe(375)
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
