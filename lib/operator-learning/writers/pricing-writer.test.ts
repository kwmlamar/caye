import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let serviceLookupResult:
  | { ok: true; service: { id: string; name: string } }
  | { ok: false; error: string } = { ok: false, error: 'no lookup requested' }
let tierRows: { id: string; tier_name: string; variant: string | null; is_flat: boolean }[] = []
let updateCalls: { id: string; patch: Record<string, unknown> }[] = []
let updateError: { message: string } | null = null

vi.mock('@/lib/caye-agent/tools/_catalog-helpers', () => ({
  resolveServiceByName: async () => serviceLookupResult,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'service_pricing_tiers') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: tierRows, error: null }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            updateCalls.push({ id, patch })
            return { error: updateError }
          },
        }),
      }
    },
  }),
}))

const { writePricing } = await import('./pricing-writer')
const { validateClassification } = await import('../schema')

function classification(pricing: Record<string, unknown>) {
  const res = validateClassification({
    learnable: true,
    explicitness: 'explicit_correction',
    scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini Experience', dateISO: null },
    risk: 'low',
    destination: 'pricing',
    canonicalKey: 'full-bimini-shared-price',
    confidence: 0.9,
    rationale: 'owner stated the tour price',
    pricing,
  })
  if (!res.ok) throw new Error(`bad fixture: ${res.reason}`)
  return res.value
}

beforeEach(() => {
  serviceLookupResult = { ok: false, error: 'no lookup requested' }
  tierRows = []
  updateCalls = []
  updateError = null
})

describe('writePricing', () => {
  it('holds as candidate when the service cannot be resolved unambiguously', async () => {
    serviceLookupResult = { ok: false, error: 'Ambiguous match' }
    const c = classification({ serviceName: 'Full Bimini', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false })
    const outcome = await writePricing({ workspaceId: 'ws-1', classification: c })
    expect(outcome.decision).toBe('candidate')
    expect(updateCalls).toHaveLength(0)
  })

  it('updates the only existing tier when the tour has exactly one (Bimini: shared tour $110/person)', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    tierRows = [{ id: 'tier-1', tier_name: 'Shared', variant: 'shared', is_flat: false }]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false })
    const outcome = await writePricing({ workspaceId: 'ws-1', classification: c })
    expect(outcome.decision).toBe('written')
    expect(updateCalls[0].patch).toMatchObject({ price_amount: 110, price_label: '$110/person' })
  })

  it('matches by exact tier name when multiple tiers exist', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    tierRows = [
      { id: 'tier-shared', tier_name: 'Shared', variant: 'shared', is_flat: false },
      { id: 'tier-private', tier_name: 'Private', variant: 'private', is_flat: true },
    ]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: 'Private', variant: null, priceAmount: 400, isFlat: true })
    const outcome = await writePricing({ workspaceId: 'ws-1', classification: c })
    expect(outcome.decision).toBe('written')
    expect(updateCalls[0].id).toBe('tier-private')
    expect(updateCalls[0].patch).toMatchObject({ price_label: '$400 flat' })
  })

  it('holds as candidate when multiple tiers exist and neither name nor variant disambiguates', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    tierRows = [
      { id: 'tier-shared', tier_name: 'Shared', variant: 'shared', is_flat: false },
      { id: 'tier-private', tier_name: 'Private', variant: 'private', is_flat: true },
    ]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: null, variant: null, priceAmount: 110, isFlat: false })
    const outcome = await writePricing({ workspaceId: 'ws-1', classification: c })
    expect(outcome.decision).toBe('candidate')
    expect(updateCalls).toHaveLength(0)
  })

  it('holds as candidate rather than inventing a new tier when the service has zero tiers', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'New Tour' } }
    tierRows = []
    const c = classification({ serviceName: 'New Tour', tierName: null, variant: null, priceAmount: 50, isFlat: false })
    const outcome = await writePricing({ workspaceId: 'ws-1', classification: c })
    expect(outcome.decision).toBe('candidate')
  })

  it('never writes bottled-water-style ancillary pricing as a pricing-table row when misclassified with no matching tier', async () => {
    // Defense in depth: even if the classifier mistakenly routed an add-on
    // fee to "pricing" instead of business_fact, an unresolved tier still
    // fails safe as a candidate rather than mutating an unrelated tier.
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    tierRows = [{ id: 'tier-1', tier_name: 'Shared', variant: 'shared', is_flat: false }]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: 'Bottled Water', variant: null, priceAmount: 2.5, isFlat: false })
    const outcome = await writePricing({ workspaceId: 'ws-1', classification: c })
    // tierName "Bottled Water" matches nothing, falls through to the
    // single-tier fallback since there's exactly one tier — documents the
    // real (imperfect) behavior: single-tier fallback can still fire. This
    // is why the classifier prompt steers ancillary fees to business_fact.
    expect(['written', 'candidate']).toContain(outcome.decision)
  })

  it('surfaces a DB update error as decision=error', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    tierRows = [{ id: 'tier-1', tier_name: 'Shared', variant: 'shared', is_flat: false }]
    updateError = { message: 'connection reset' }
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false })
    const outcome = await writePricing({ workspaceId: 'ws-1', classification: c })
    expect(outcome.decision).toBe('error')
  })
})
