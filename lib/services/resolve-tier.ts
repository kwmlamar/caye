/**
 * resolve-tier.ts
 *
 * Deterministic pricing tier resolution. Caye's reply path calls this instead
 * of paraphrasing workspace_ai_config.pricing_info. The function is pure and
 * synchronous given an array of tier rows — DB lookup happens in the caller.
 *
 * The Stallings 2026-05-29 case (see Clients/bimini-island-tours.md) showed
 * that LLM-generated pricing math is unreliable: a 2-person Private tour was
 * quoted at $150/person (the Private-Group-of-4+ rate) instead of $375 flat
 * (the Private-2-max rate). Deterministic tier matching with explicit
 * ambiguity holds eliminates that class of error.
 *
 * RESULT TYPES:
 *   - { ok: true, ... }       — exactly one tier matches, Caye can quote
 *   - { ok: false, hold: ... } — ambiguous / missing / out-of-range, hold for owner
 */

export interface PricingTier {
  id: string
  tier_name: string
  group_size_min: number
  group_size_max: number
  price_amount: number
  price_label: string
  is_flat: boolean
  is_ambiguous_above: boolean
  display_order: number
}

export type ResolveTierResult =
  | {
      ok: true
      tier: PricingTier
      groupSize: number
      /** What Caye should drop into the email — the verbatim label */
      priceLabel: string
      /** Computed party total in whole dollars */
      totalAmount: number
      /** Human-readable total string e.g. "$300 total" */
      totalLabel: string
    }
  | {
      ok: false
      hold: HoldReason
      groupSize: number
      /** Tiers we considered, returned so the operator-side note can show them */
      candidateTiers: PricingTier[]
      message: string
    }

export type HoldReason =
  | 'no_tiers_configured'
  | 'group_size_below_minimum'
  | 'group_size_in_gap_between_tiers'
  | 'group_size_above_maximum'
  | 'multiple_tiers_matched'
  | 'tier_explicitly_ambiguous_above'

/**
 * Match a customer's group size to exactly one pricing tier, or hold.
 *
 * Tier matching rules (in priority order):
 *  1. If no tiers configured → hold (operator hasn't set up pricing yet)
 *  2. If group_size is in exactly one tier's [min, max] range → match it
 *  3. If group_size matches multiple tiers → hold (operator has overlapping tiers)
 *  4. If group_size is below the lowest min → hold (e.g. asked for 0 people)
 *  5. If group_size is above the highest max AND the matching tier has
 *     is_ambiguous_above=true → hold (e.g. "starting at $X" pricing)
 *  6. If group_size is above the highest max → hold ("we don't have a tier for groups that large")
 *  7. If group_size falls in a gap between tiers (e.g. tier A is 1-2, tier B is 4+, group=3)
 *     → hold (ambiguous which tier the customer should be placed in)
 */
export function resolveTier(tiers: PricingTier[], groupSize: number): ResolveTierResult {
  // Guard: input sanitization
  if (!Number.isInteger(groupSize) || groupSize < 1) {
    return {
      ok: false,
      hold: 'group_size_below_minimum',
      groupSize,
      candidateTiers: tiers,
      message: `Invalid group size ${groupSize} — must be a positive integer.`,
    }
  }

  if (tiers.length === 0) {
    return {
      ok: false,
      hold: 'no_tiers_configured',
      groupSize,
      candidateTiers: [],
      message:
        'No pricing tiers are configured for this tour yet. ' +
        'Operator must add pricing in the service catalog before Caye can quote.',
    }
  }

  // Sort by display_order to make iteration deterministic
  const sorted = [...tiers].sort((a, b) => a.display_order - b.display_order)

  const lowestMin = Math.min(...sorted.map(t => t.group_size_min))
  const highestMax = Math.max(...sorted.map(t => t.group_size_max))

  // Below the lowest tier
  if (groupSize < lowestMin) {
    return {
      ok: false,
      hold: 'group_size_below_minimum',
      groupSize,
      candidateTiers: sorted,
      message: `Group size ${groupSize} is below the minimum tier (${lowestMin}). Operator should confirm if this is valid.`,
    }
  }

  // Find all tiers that match the group_size
  const matched = sorted.filter(
    t => groupSize >= t.group_size_min && groupSize <= t.group_size_max
  )

  if (matched.length === 1) {
    const tier = matched[0]
    // Ambiguous-above tiers are "starting at" pricing — we hold even if exactly matched,
    // because the price is a floor, not a quote. Owner needs to confirm the real number.
    if (tier.is_ambiguous_above) {
      return {
        ok: false,
        hold: 'tier_explicitly_ambiguous_above',
        groupSize,
        candidateTiers: sorted,
        message: `Tier "${tier.tier_name}" is marked ambiguous (e.g. "starting at $X" pricing). Owner needs to confirm the actual price for ${groupSize} ${groupSize === 1 ? 'person' : 'people'}.`,
      }
    }

    const total = tier.is_flat ? tier.price_amount : tier.price_amount * groupSize
    return {
      ok: true,
      tier,
      groupSize,
      priceLabel: tier.price_label,
      totalAmount: total,
      totalLabel: `$${formatMoney(total)} total`,
    }
  }

  if (matched.length > 1) {
    return {
      ok: false,
      hold: 'multiple_tiers_matched',
      groupSize,
      candidateTiers: matched,
      message: `Group size ${groupSize} matches multiple tiers (${matched.map(t => t.tier_name).join(', ')}). Operator must fix overlapping tier definitions.`,
    }
  }

  // No tier matched — either above max or in a gap
  if (groupSize > highestMax) {
    return {
      ok: false,
      hold: 'group_size_above_maximum',
      groupSize,
      candidateTiers: sorted,
      message: `Group size ${groupSize} is above the highest configured tier (${highestMax}). Owner needs to confirm pricing for larger parties.`,
    }
  }

  // Gap case (e.g. tier A covers 1-2, tier B covers 4+, customer asks for 3)
  return {
    ok: false,
    hold: 'group_size_in_gap_between_tiers',
    groupSize,
    candidateTiers: sorted,
    message: `Group size ${groupSize} falls in a gap between configured tiers (e.g. between "Private (2 max)" and "Private Group (min 4)"). Owner needs to confirm which tier applies.`,
  }
}

function formatMoney(n: number): string {
  // No decimals if whole number, else 2 decimals
  return n % 1 === 0 ? String(n) : n.toFixed(2)
}
