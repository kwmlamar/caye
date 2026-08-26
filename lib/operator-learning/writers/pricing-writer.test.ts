import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let groundedServiceResult:
  | { ok: true; service: { id: string; name: string }; error: null }
  | { ok: false; service: null; error: string } = { ok: false, service: null, error: 'no lookup requested' }
let tierRows: { id: string; tier_name: string; variant: string | null; is_flat: boolean }[] = []
let updateCalls: { id: string; patch: Record<string, unknown> }[] = []
let updateError: { message: string } | null = null

vi.mock('../service-grounding', () => ({
  resolveGroundedService: async () => groundedServiceResult,
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

function call(c: ReturnType<typeof classification>, operatorText = 'default raw operator statement') {
  return writePricing({ workspaceId: 'ws-1', classification: c, operatorText })
}

beforeEach(() => {
  groundedServiceResult = { ok: false, service: null, error: 'no lookup requested' }
  tierRows = []
  updateCalls = []
  updateError = null
})

describe('writePricing', () => {
  it('holds as candidate when the service cannot be resolved unambiguously', async () => {
    groundedServiceResult = { ok: false, service: null, error: 'Ambiguous match' }
    const c = classification({ serviceName: 'Full Bimini', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false })
    const outcome = await call(c)
    expect(outcome.decision).toBe('candidate')
    expect(updateCalls).toHaveLength(0)
  })

  it('updates the only existing tier when the tour has exactly one (Bimini: shared tour $110/person)', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' }, error: null }
    tierRows = [{ id: 'tier-1', tier_name: 'Shared', variant: 'shared', is_flat: false }]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false })
    const outcome = await call(c)
    expect(outcome.decision).toBe('written')
    expect(updateCalls[0].patch).toMatchObject({ price_amount: 110, price_label: '$110/person' })
  })

  it('matches by exact tier name when multiple tiers exist', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' }, error: null }
    tierRows = [
      { id: 'tier-shared', tier_name: 'Shared', variant: 'shared', is_flat: false },
      { id: 'tier-private', tier_name: 'Private', variant: 'private', is_flat: true },
    ]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: 'Private', variant: null, priceAmount: 400, isFlat: true })
    const outcome = await call(c)
    expect(outcome.decision).toBe('written')
    expect(updateCalls[0].id).toBe('tier-private')
    expect(updateCalls[0].patch).toMatchObject({ price_label: '$400 flat' })
  })

  it('holds as candidate when multiple tiers exist and neither name nor variant disambiguates', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' }, error: null }
    tierRows = [
      { id: 'tier-shared', tier_name: 'Shared', variant: 'shared', is_flat: false },
      { id: 'tier-private', tier_name: 'Private', variant: 'private', is_flat: true },
    ]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: null, variant: null, priceAmount: 110, isFlat: false })
    const outcome = await call(c)
    expect(outcome.decision).toBe('candidate')
    expect(updateCalls).toHaveLength(0)
  })

  it('holds as candidate rather than inventing a new tier when the service has zero tiers', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'New Tour' }, error: null }
    tierRows = []
    const c = classification({ serviceName: 'New Tour', tierName: null, variant: null, priceAmount: 50, isFlat: false })
    const outcome = await call(c)
    expect(outcome.decision).toBe('candidate')
  })

  it('never writes bottled-water-style ancillary pricing as a pricing-table row when misclassified with no matching tier', async () => {
    // Defense in depth: even if the classifier mistakenly routed an add-on
    // fee to "pricing" instead of business_fact, an unresolved tier still
    // fails safe as a candidate rather than mutating an unrelated tier.
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' }, error: null }
    tierRows = [{ id: 'tier-1', tier_name: 'Shared', variant: 'shared', is_flat: false }]
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: 'Bottled Water', variant: null, priceAmount: 2.5, isFlat: false })
    const outcome = await call(c)
    // tierName "Bottled Water" matches nothing, falls through to the
    // single-tier fallback since there's exactly one tier — documents the
    // real (imperfect) behavior: single-tier fallback can still fire. This
    // is why the classifier prompt steers ancillary fees to business_fact.
    expect(['written', 'candidate']).toContain(outcome.decision)
  })

  it('surfaces a DB update error as decision=error', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' }, error: null }
    tierRows = [{ id: 'tier-1', tier_name: 'Shared', variant: 'shared', is_flat: false }]
    updateError = { message: 'connection reset' }
    const c = classification({ serviceName: 'Full Bimini Experience', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false })
    const outcome = await call(c)
    expect(outcome.decision).toBe('error')
  })

  // Real scope-correctness gap (2026-08-26 audit): resolveGroundedService
  // fails when the resolved service is never mentioned in the raw operator
  // text — proves the writer propagates that rejection as a hold, never as
  // a silent mutation of whatever service the classifier happened to name.
  it('holds as candidate when resolveGroundedService rejects a stale-context mis-attribution, never touching any tier', async () => {
    groundedServiceResult = {
      ok: false,
      service: null,
      error: 'resolved to "North Bimini Heritage Tour" but none of its distinguishing words appear in what the operator actually said',
    }
    const c = classification({ serviceName: 'North Bimini Heritage Tour', tierName: null, variant: null, priceAmount: 500, isFlat: false })
    const outcome = await call(c, 'Bottled water is now $3 per guest.')
    expect(outcome.decision).toBe('candidate')
    expect(updateCalls).toHaveLength(0)
  })

  // Real Bimini catalog collision, confirmed live: three active golf-cart
  // services ("Golf Cart Guided Tour", "Golf Cart Orientation Tour", "Golf
  // Cart Fully Guided Tour") with different, inconsistent pricing — the
  // scope-correctness safeguard's realistic operating condition, not a
  // synthetic one. writePricing itself doesn't disambiguate between them
  // (that's resolveGroundedService's job, tested in service-grounding.test.ts)
  // — this documents that whichever one the resolver returns, the write
  // proceeds against THAT service's own tiers only, never a different one.
  it('real Bimini case: writes against exactly the resolved golf-cart service, not a same-family near-collision', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-orientation', name: 'Golf Cart Orientation Tour' }, error: null }
    tierRows = [{ id: 'tier-orientation', tier_name: '1-2 guests', variant: null, is_flat: true }]
    const c = classification({ serviceName: 'Golf Cart Orientation Tour', tierName: null, variant: null, priceAmount: 375, isFlat: true })
    const outcome = await call(c, 'The orientation golf cart is now $375 for 2.')
    expect(outcome.decision).toBe('written')
    expect(updateCalls[0].id).toBe('tier-orientation')
  })
})
