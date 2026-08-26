import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let lookupResult: { ok: true; service: { id: string; name: string } } | { ok: false; error: string; candidates?: string[] } = {
  ok: false,
  error: 'not configured',
}
vi.mock('@/lib/caye-agent/tools/_catalog-helpers', () => ({
  resolveServiceByName: async () => lookupResult,
}))

const { resolveGroundedService, serviceMentionGrounded } = await import('./service-grounding')

beforeEach(() => {
  lookupResult = { ok: false, error: 'not configured' }
})

describe('serviceMentionGrounded — pure token-overlap check', () => {
  it('grounded when the raw text plainly names the resolved service', () => {
    expect(serviceMentionGrounded('The North Bimini Heritage Tour price is now $230.', 'North Bimini Heritage Tour')).toBe(true)
  })

  it('grounded through a colloquial reference sharing a real distinguishing word', () => {
    expect(serviceMentionGrounded('The shared heritage rate changes to $230.', 'North Bimini Heritage Tour')).toBe(true)
  })

  it('NOT grounded when the raw text names a completely different topic than the resolved service', () => {
    // The real risk this exists to catch: the classifier resolved a
    // service, but the operator's own words never mentioned anything like
    // it — a stale-context mis-attribution.
    expect(serviceMentionGrounded('Bottled water is $2.50 per guest now.', 'North Bimini Heritage Tour')).toBe(false)
  })

  it('is vacuously grounded when the resolved name has no meaningful (non-filler) tokens', () => {
    expect(serviceMentionGrounded('anything at all', 'Tour')).toBe(true)
  })

  // Real Bimini catalog collision, confirmed live: THREE active golf-cart
  // services exist today — "Golf Cart Guided Tour" (original, never
  // deactivated), "Golf Cart Orientation Tour", "Golf Cart Fully Guided
  // Tour" (the two newer ones an owner correction built on 2026-08-14 to
  // replace the first, which was never actually retired).
  it('real Bimini case: a generic "golf cart tour" statement grounds against ALL THREE real golf-cart services equally — resolution ambiguity is real, not synthetic', () => {
    expect(serviceMentionGrounded('The golf cart tour is now $50.', 'Golf Cart Guided Tour')).toBe(true)
    expect(serviceMentionGrounded('The golf cart tour is now $50.', 'Golf Cart Orientation Tour')).toBe(true)
    expect(serviceMentionGrounded('The golf cart tour is now $50.', 'Golf Cart Fully Guided Tour')).toBe(true)
    // Grounding alone can't disambiguate between the three — that's exactly
    // why matchServiceByName's own tie-detection (highMargin) has to be the
    // FIRST gate; grounding is the second, independent one.
  })

  it('a more specific real statement grounds against the correct one of the three and not misleadingly against an unrelated one', () => {
    expect(serviceMentionGrounded('The orientation golf cart is now $50.', 'Golf Cart Orientation Tour')).toBe(true)
    expect(serviceMentionGrounded('The orientation golf cart is now $50.', 'North Bimini Heritage Tour')).toBe(false)
  })
})

describe('resolveGroundedService — combines catalog resolution with raw-text grounding', () => {
  it('succeeds when both the catalog match and the grounding check pass', async () => {
    lookupResult = { ok: true, service: { id: 'svc-1', name: 'North Bimini Heritage Tour' } }
    const result = await resolveGroundedService(
      {} as never,
      'ws-1',
      'North Bimini Heritage Tour',
      'The North Bimini Heritage Tour price is now $230.'
    )
    expect(result.ok).toBe(true)
    expect(result.service?.id).toBe('svc-1')
  })

  it('fails when resolveServiceByName itself fails (ambiguous/no match) — grounding never even runs', async () => {
    lookupResult = { ok: false, error: 'Ambiguous match', candidates: ['A', 'B'] }
    const result = await resolveGroundedService({} as never, 'ws-1', 'the tour', 'the tour price is now $50.')
    expect(result.ok).toBe(false)
  })

  // The exact failure mode this module exists to catch: the string-match
  // resolved CONFIDENTLY, but to a service the raw operator text never
  // actually mentioned — a classifier mis-attribution from stale context.
  it('fails when the catalog match succeeds but the resolved service is never mentioned in the raw operator text (stale-context mis-attribution)', async () => {
    lookupResult = { ok: true, service: { id: 'svc-1', name: 'North Bimini Heritage Tour' } }
    const result = await resolveGroundedService(
      {} as never,
      'ws-1',
      'North Bimini Heritage Tour', // the classifier's own (wrong) paraphrase
      'Bottled water is $2.50 per guest now.' // what the operator actually said
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/North Bimini Heritage Tour/)
  })
})
