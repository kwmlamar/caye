import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveServiceByName } from '@/lib/caye-agent/tools/_catalog-helpers'
import type { ClassificationResult } from '../schema'
import type { WriteOutcome } from './types'

interface TierRow {
  id: string
  tier_name: string
  variant: string | null
  is_flat: boolean
}

function formatPriceLabel(amount: number, isFlat: boolean): string {
  return isFlat ? `$${amount} flat` : `$${amount}/person`
}

/**
 * writers/pricing-writer.ts
 *
 * Deliberately UPDATE-only: it changes the price on an EXISTING,
 * unambiguously-resolved tier (matching update_service_price.ts's job), and
 * never creates a brand-new tier from a single correction — that stays a
 * deliberate owner action via add_pricing_tier in back-office chat. Pricing
 * never lands as business_facts prose (routing hard rule #1) — either this
 * resolves cleanly, or it's held as a candidate.
 */
export async function writePricing(args: {
  workspaceId: string
  classification: ClassificationResult
}): Promise<WriteOutcome> {
  const payload = args.classification.pricing
  if (!payload) return { decision: 'error', reason: 'destination pricing but no pricing payload' }

  const supabase = createServiceClient()
  const lookup = await resolveServiceByName(supabase, args.workspaceId, payload.serviceName)
  if (!lookup.ok) {
    return { decision: 'candidate', reason: `service resolution failed: ${lookup.error}` }
  }

  const { data: tierRows, error: tierErr } = await supabase
    .from('service_pricing_tiers')
    .select('id, tier_name, variant, is_flat')
    .eq('service_id', lookup.service.id)
    .eq('workspace_id', args.workspaceId)
  if (tierErr) return { decision: 'error', reason: `tier lookup failed: ${tierErr.message}` }

  const tiers = (tierRows ?? []) as TierRow[]
  const matched = resolveTargetTier(tiers, payload)
  if (!matched) {
    return {
      decision: 'candidate',
      reason:
        tiers.length === 0
          ? `"${lookup.service.name}" has no existing pricing tiers to update — adding a new tier needs an explicit owner action`
          : `could not uniquely match a tier on "${lookup.service.name}" (${tiers.length} tiers exist, none confidently matched)`,
    }
  }

  const newLabel = formatPriceLabel(payload.priceAmount, matched.is_flat)
  const { error: updErr } = await supabase
    .from('service_pricing_tiers')
    .update({ price_amount: payload.priceAmount, price_label: newLabel, updated_at: new Date().toISOString() })
    .eq('id', matched.id)
  if (updErr) return { decision: 'error', reason: `pricing update failed: ${updErr.message}` }

  return {
    decision: 'written',
    targetTable: 'service_pricing_tiers',
    targetRecordId: matched.id,
    supersededRecordId: null,
    reason: `updated ${lookup.service.name} / ${matched.tier_name} to ${newLabel}`,
  }
}

function resolveTargetTier(
  tiers: TierRow[],
  payload: NonNullable<ClassificationResult['pricing']>
): TierRow | null {
  if (payload.tierName) {
    const byName = tiers.find((t) => t.tier_name.toLowerCase() === payload.tierName!.toLowerCase())
    if (byName) return byName
  }
  if (payload.variant) {
    const byVariant = tiers.filter((t) => (t.variant ?? '').toLowerCase() === payload.variant!.toLowerCase())
    if (byVariant.length === 1) return byVariant[0]
  }
  if (tiers.length === 1) return tiers[0]
  return null
}
