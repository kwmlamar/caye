import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

let activeFacts: Array<{
  id: string
  fact: string
  source: string
  expires_at: string | null
  canonical_key?: string | null
  service_id?: string | null
}> = []
let conflictResult: {
  conflictId: string | null
  resolution: 'supersede' | 'ambiguous' | null
  checkFailed?: boolean
} = { conflictId: null, resolution: null }
let conflictCtxSeen: { newFactScopeLabel?: string } | null = null
let conflictCandidatesSeen: Array<{ id: string; scopeLabel?: string }> | null = null
let semanticMatchResult: { matchId: string | null } = { matchId: null }
let scopedServices: Array<{ id: string; name: string }> = []
let groundedServiceResult:
  | { ok: true; service: { id: string; name: string }; error: null }
  | { ok: false; service: null; error: string } = {
  ok: false,
  service: null,
  error: 'no lookup requested',
}
let rpcParams: Record<string, unknown> | null = null
let rpcResponse = {
  id: 'fact-new',
  created_at: '2026-08-30T00:00:00Z',
  superseded_id: null as string | null,
}

vi.mock('@/lib/business-fact-conflict', () => ({
  findConflictingFact: async (
    _newFact: string,
    candidates: Array<{ id: string; scopeLabel?: string }>,
    ctx: { newFactScopeLabel?: string }
  ) => {
    conflictCandidatesSeen = candidates
    conflictCtxSeen = ctx
    return conflictResult
  },
}))

vi.mock('@/lib/business-fact-semantic-match', () => ({
  findSemanticFactMatch: async () => semanticMatchResult,
}))

vi.mock('../service-grounding', () => ({
  resolveGroundedService: async () => groundedServiceResult,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'business_facts') {
        return {
          select: () => ({
            eq: () => ({
              is: async () => ({ data: activeFacts, error: null }),
            }),
          }),
        }
      }
      if (table === 'booking_services') {
        return {
          select: () => ({
            in: async () => ({ data: scopedServices, error: null }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    rpc(fn: string, params: Record<string, unknown>) {
      if (fn !== 'write_typed_business_memory_atomic') throw new Error(`unexpected rpc: ${fn}`)
      rpcParams = params
      return {
        single: async () => ({ data: rpcResponse, error: null }),
      }
    },
  }),
}))

const { writeBusinessFact } = await import('./business-fact-writer')
const { validateClassification } = await import('../schema')

function classification(overrides: Record<string, unknown> = {}) {
  const result = validateClassification({
    learnable: true,
    explicitness: 'explicit_correction',
    scope: { kind: 'standing', target: 'workspace', serviceName: null, dateISO: null },
    risk: 'low',
    destination: 'business_fact',
    canonicalKey: 'payment-method',
    confidence: 0.9,
    rationale: 'owner stated reusable business knowledge',
    businessFact: { category: 'policy', text: 'We only accept online payment.' },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

function write(
  value = classification(),
  overrides: Partial<{ workspaceId: string; callerRole: string; operatorText: string }> = {}
) {
  return writeBusinessFact({
    workspaceId: 'ws-1',
    callerRole: 'owner',
    operatorText: 'default operator statement',
    classification: value,
    ...overrides,
  })
}

beforeEach(() => {
  activeFacts = []
  conflictResult = { conflictId: null, resolution: null }
  conflictCtxSeen = null
  conflictCandidatesSeen = null
  semanticMatchResult = { matchId: null }
  scopedServices = []
  groundedServiceResult = { ok: false, service: null, error: 'no lookup requested' }
  rpcParams = null
  rpcResponse = {
    id: 'fact-new',
    created_at: '2026-08-30T00:00:00Z',
    superseded_id: null,
  }
})

describe('writeBusinessFact mature regression contracts', () => {
  it('preserves service-vs-workspace scope labels when judging conflicts', async () => {
    scopedServices = [{ id: 'svc-heritage', name: 'North Bimini Heritage Tour' }]
    activeFacts = [
      {
        id: 'fact-pink-building',
        fact: 'The meeting point for the Heritage Tour is the pink building by the dock.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: null,
        service_id: 'svc-heritage',
      },
    ]

    await write(
      classification({
        canonicalKey: 'all-tours-pickup-location',
        businessFact: { category: 'logistics', text: 'The pickup location for all tours is the Casino Tram Stop.' },
      })
    )

    expect(conflictCtxSeen).toMatchObject({
      newFactScopeLabel: 'workspace-wide (applies to all services)',
    })
    expect(conflictCandidatesSeen).toEqual([
      expect.objectContaining({
        id: 'fact-pink-building',
        scopeLabel: 'specific to North Bimini Heritage Tour',
      }),
    ])
  })

  it('holds stale-context service attribution instead of broadening it', async () => {
    groundedServiceResult = {
      ok: false,
      service: null,
      error: 'resolved service was not actually grounded in the operator text',
    }

    const outcome = await write(
      classification({
        risk: 'low',
        scope: {
          kind: 'standing',
          target: 'service',
          serviceName: 'Full Bimini Experience',
          dateISO: null,
        },
        businessFact: { category: 'logistics', text: 'Guests meet by the tram stop.' },
      })
    )

    expect(outcome.decision).toBe('candidate')
    expect(rpcParams).toBeNull()
  })

  it.each([
    'Payment is online only.',
    'No cash or Zelle.',
    'Customers must pay using the invoice link.',
  ])('chains paraphrase %s onto an existing fact when semantic matching says same topic', async (paraphrase) => {
    activeFacts = [
      {
        id: 'fact-online-only',
        fact: 'We only take online payments.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: 'payment-method',
      },
    ]
    semanticMatchResult = { matchId: 'fact-online-only' }
    rpcResponse.superseded_id = 'fact-online-only'

    const outcome = await write(
      classification({
        canonicalKey: `new-key-${paraphrase.length}`,
        businessFact: { category: 'policy', text: paraphrase },
      })
    )

    expect(outcome.decision).toBe('superseded_and_written')
    expect(rpcParams).toMatchObject({
      p_supersede_id: 'fact-online-only',
      p_canonical_key: 'payment-method',
    })
  })

  it('does not force-collapse operationally distinct facts when semantic matching says they differ', async () => {
    activeFacts = [
      {
        id: 'fact-card-only',
        fact: 'All payments are made in advance by card only.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: 'payment-method-card',
      },
    ]
    semanticMatchResult = { matchId: null }

    const outcome = await write(
      classification({
        canonicalKey: 'payment-method-online',
        businessFact: { category: 'policy', text: 'Online payment only.' },
      })
    )

    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({
      p_supersede_id: null,
      // This test predates canonicalPropertyKey()'s scope-prefixed, alias-collapsed
      // identity model (added in "Make continuous business learning canonical and
      // conflict-aware", 2ce44944, after this file's "restore writer regression
      // coverage" commit 4225e127) and was never updated for it. There is no
      // existing fact to inherit a key from here — matchId is null and no active
      // row shares this canonical key — so the writer must compute a fresh one via
      // canonicalPropertyKey(), which always returns a scope-prefixed, alias-form
      // key (see canonical-key.migration.test.ts: 'workspace.meeting_point', not
      // a raw suggested key). The literal, unprefixed 'payment-method-online' is
      // not a value canonicalPropertyKey() can ever produce; 'workspace.payment_method'
      // is the correct resolved identity for this fact.
      p_canonical_key: 'workspace.payment_method',
    })
  })

  it('does not invent correction lineage for non-correction same-topic replacement', async () => {
    activeFacts = [
      {
        id: 'fact-old',
        fact: 'Guests receive one bottle of water.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: 'water-included',
      },
    ]
    semanticMatchResult = { matchId: 'fact-old' }
    rpcResponse.superseded_id = 'fact-old'

    const outcome = await write(
      classification({
        explicitness: 'explicit_statement',
        canonicalKey: 'water-policy-new-wording',
        businessFact: { category: 'service_detail', text: 'One water bottle is included per guest.' },
      })
    )

    expect(outcome.decision).toBe('superseded_and_written')
    expect(rpcParams).toMatchObject({
      p_supersede_id: 'fact-old',
      p_correction_of_fact_id: null,
    })
  })
})
