import { describe, it, expect } from 'vitest'
import { resolveTier, type PricingTier } from './resolve-tier'

const t = (o: Partial<PricingTier>): PricingTier => ({
  id: 'x', tier_name: '', variant: null, group_size_min: 1, group_size_max: 1,
  price_amount: 0, price_label: '', is_flat: false, is_ambiguous_above: false,
  display_order: 0, ...o,
})

// Bimini's live Full Bimini Experience catalog after the 2026-08-09 fix.
const fullBimini: PricingTier[] = [
  t({ tier_name: 'Shared', variant: 'shared', group_size_min: 1, group_size_max: 50, price_amount: 199, price_label: '$199/person', display_order: 10 }),
  t({ tier_name: 'Private Solo (1)', variant: 'private', group_size_min: 1, group_size_max: 1, price_amount: 275, price_label: '$275 total', is_flat: true, display_order: 15 }),
  t({ tier_name: 'Private Couple (2)', variant: 'private', group_size_min: 2, group_size_max: 2, price_amount: 450, price_label: '$450 total', is_flat: true, display_order: 20 }),
  t({ tier_name: 'Private Family (3-6)', variant: 'private', group_size_min: 3, group_size_max: 6, price_amount: 215, price_label: '$215/person', display_order: 30 }),
]

describe('Full Bimini solo pricing after the fix', () => {
  it('solo + private resolves to $275 flat', () => {
    const r = resolveTier(fullBimini, 1, 'private')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.totalAmount).toBe(275); expect(r.priceLabel).toBe('$275 total') }
  })
  it('solo + shared stays $199 per person', () => {
    const r = resolveTier(fullBimini, 1, 'shared')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totalAmount).toBe(199)
  })
  it('solo with NO variant now holds instead of guessing', () => {
    const r = resolveTier(fullBimini, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.hold).toBe('multiple_tiers_matched')
  })
  it('2 guests private is unchanged at $450', () => {
    const r = resolveTier(fullBimini, 2, 'private')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totalAmount).toBe(450)
  })
  it('3 guests private is unchanged at $215pp', () => {
    const r = resolveTier(fullBimini, 3, 'private')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.totalAmount).toBe(645)
  })
})
