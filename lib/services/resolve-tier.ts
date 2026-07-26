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
 * VARIANT AXIS (2026-07-26): Karenda's confirmed 07-23 pricing introduced
 * tours where a single group size has more than one legitimate price — e.g.
 * North Bimini Heritage Tour at 1 guest is $110 (Standard/shared) OR $200
 * (Private). group_size alone no longer uniquely determines price for these
 * tours. `variant` (e.g. 'standard' | 'private') is the second axis: when
 * multiple tiers match a group size, passing the customer's chosen variant
 * narrows to exactly one. Omitting variant preserves the original
 * single-axis behavior for tours that don't need it (each group size still
 * maps to exactly one tier) and surfaces a hold that lists the available
 * variants otherwise — see HoldReason.
 *
 * RESULT TYPES:
 *   - { ok: true, ... }       — exactly one tier matches, Caye can quote
 *   - { ok: false, hold: ... } — ambiguous / missing / out-of-range, hold for owner
 */

export interface PricingTier {
  id: string
  tier_name: string
  /**
   * Machine-stable key for the variant axis (e.g. 'standard', 'private').
   * Null/undefined for tiers where group_size alone is unambiguous — the
   * vast majority of existing tours. Distinct from tier_name, which is the
   * human-facing label and can change wording without breaking resolution.
   */
  variant?: string | null
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
  | 'variant_not_available'

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
 *  8. If group_size matches multiple tiers AND a variant is supplied → narrow to the
 *     tier(s) whose `variant` matches; exactly one remaining → resolve it (still subject
 *     to is_ambiguous_above); zero remaining → hold 'variant_not_available' (the caller
 *     asked for a variant this tour doesn't offer at this group size); more than one
 *     remaining → hold 'multiple_tiers_matched' (operator has duplicate variant rows)
 */
export function resolveTier(
  tiers: PricingTier[],
  groupSize: number,
  variant?: string | null
): ResolveTierResult {
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

  const finalize = (tier: PricingTier): ResolveTierResult => {
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

  if (matched.length === 1) {
    return finalize(matched[0])
  }

  if (matched.length > 1) {
    // More than one tier covers this group size — that's only resolvable
    // deterministically if the caller told us which variant (shared/private/
    // etc.) the customer wants. No variant supplied: surface all candidates
    // so the front-desk agent can ask, then call back with variant set.
    if (variant != null) {
      const variantMatched = matched.filter(t => t.variant === variant)
      if (variantMatched.length === 1) {
        return finalize(variantMatched[0])
      }
      if (variantMatched.length === 0) {
        return {
          ok: false,
          hold: 'variant_not_available',
          groupSize,
          candidateTiers: matched,
          message: `No tier for variant "${variant}" at group size ${groupSize}. Available variants here: ${matched.map(t => t.variant ?? t.tier_name).join(', ')}.`,
        }
      }
      // variantMatched.length > 1 — duplicate variant rows, operator data error.
      return {
        ok: false,
        hold: 'multiple_tiers_matched',
        groupSize,
        candidateTiers: variantMatched,
        message: `Group size ${groupSize} and variant "${variant}" match multiple tiers (${variantMatched.map(t => t.tier_name).join(', ')}). Operator must fix duplicate tier definitions.`,
      }
    }

    return {
      ok: false,
      hold: 'multiple_tiers_matched',
      groupSize,
      candidateTiers: matched,
      message: `Group size ${groupSize} matches multiple tiers (${matched.map(t => t.tier_name).join(', ')}). ${matched.every(t => t.variant) ? 'Ask the customer which they want, then call again with variant set.' : 'Operator must fix overlapping tier definitions.'}`,
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
