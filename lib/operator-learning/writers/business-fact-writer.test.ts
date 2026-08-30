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
let semanticMatchResult: { matchId: string | null } = { matchId: null }
let rpcName: string | null = null
let rpcParams: Record<string, unknown> | null = null
let rpcError: { message: string } | null = null
let rpcResponse = {
  id: 'fact-new',
  created_at: '2026-08-30T00:00:00Z',
  superseded_id: null as string | null,
}
let groundedServiceResult:
  | { ok: true; service: { id: string; name: string }; error: null }
  | { ok: false; service: null; error: string } = {
    ok: false,
    service: null,
    error: 'no lookup requested',
  }

vi.mock('@/lib/business-fact-conflict', () => ({
  findConflictingFact: async () => conflictResult,
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
            in: async () => ({ data: [], error: null }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    rpc(fn: string, params: Record<string, unknown>) {
      rpcName = fn
      rpcParams = params
      return {
        single: async () =>
          rpcError
            ? { data: null, error: rpcError }
            : { data: rpcResponse, error: null },
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
    rationale: 'owner corrected payment policy',
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
    operatorText: 'We only accept online payment now.',
    classification: value,
    ...overrides,
  })
}

beforeEach(() => {
  activeFacts = []
  conflictResult = { conflictId: null, resolution: null }
  semanticMatchResult = { matchId: null }
  rpcName = null
  rpcParams = null
  rpcError = null
  rpcResponse = {
    id: 'fact-new',
    created_at: '2026-08-30T00:00:00Z',
    superseded_id: null,
  }
  groundedServiceResult = { ok: false, service: null, error: 'no lookup requested' }
})

describe('writeBusinessFact typed operating memory', () => {
  it('writes explicit corrections through the typed atomic RPC with provenance and authority', async () => {
    const outcome = await write()

    expect(outcome.decision).toBe('written')
    expect(rpcName).toBe('write_typed_business_memory_atomic')
    expect(rpcParams).toMatchObject({
      p_workspace_id: 'ws-1',
      p_source: 'operator-learning',
      p_memory_type: 'correction',
      p_knowledge_mode: 'explicit',
      p_confidence: 0.9,
      p_sensitivity: 'workspace',
      p_authority_kind: 'owner',
      p_subject_type: 'workspace',
      p_subject_id: null,
      p_correction_of_fact_id: null,
      p_provenance: expect.objectContaining({
        producer: 'operator-learning-router',
        explicitness: 'explicit_correction',
      }),
    })
  })

  it('supersedes a conflicting fact and records contradiction/correction lineage', async () => {
    activeFacts = [
      {
        id: 'fact-old',
        fact: 'We accept cash.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: 'payment-method',
      },
    ]
    conflictResult = { conflictId: 'fact-old', resolution: 'supersede' }
    rpcResponse.superseded_id = 'fact-old'

    const outcome = await write()

    expect(outcome.decision).toBe('superseded_and_written')
    expect(rpcParams).toMatchObject({
      p_supersede_id: 'fact-old',
      p_contradicts_fact_id: 'fact-old',
      p_correction_of_fact_id: 'fact-old',
    })
  })

  it('holds ambiguous contradictions instead of poisoning durable memory', async () => {
    activeFacts = [
      { id: 'fact-old', fact: 'Tours begin at 9.', source: 'owner-direct', expires_at: null },
    ]
    conflictResult = { conflictId: 'fact-old', resolution: 'ambiguous' }

    const outcome = await write()

    expect(outcome.decision).toBe('candidate')
    expect(rpcName).toBeNull()
  })

  it('fails closed if contradiction checking fails', async () => {
    activeFacts = [
      { id: 'fact-old', fact: 'Cash is not accepted.', source: 'owner-direct', expires_at: null },
    ]
    conflictResult = { conflictId: null, resolution: null, checkFailed: true }

    const outcome = await write()

    expect(outcome.decision).toBe('error')
    expect(rpcName).toBeNull()
  })

  it('reuses the existing canonical chain on semantic same-topic matches', async () => {
    activeFacts = [
      {
        id: 'fact-old',
        fact: 'Payments are online only.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: 'payment-policy-online',
      },
    ]
    semanticMatchResult = { matchId: 'fact-old' }
    rpcResponse.superseded_id = 'fact-old'

    await write(classification({ canonicalKey: 'fresh-llm-wording' }))

    expect(rpcParams).toMatchObject({
      p_supersede_id: 'fact-old',
      p_canonical_key: 'payment-policy-online',
    })
  })

  it('attaches service scope only after grounded service resolution', async () => {
    groundedServiceResult = {
      ok: true,
      service: { id: 'svc-1', name: 'Full Bimini Experience' },
      error: null,
    }

    await write(
      classification({
        scope: {
          kind: 'standing',
          target: 'service',
          serviceName: 'Full Bimini Experience',
          dateISO: null,
        },
      }),
      { operatorText: 'For the Full Bimini Experience, guests meet at the tram stop.' }
    )

    expect(rpcParams).toMatchObject({
      p_service_id: 'svc-1',
      p_subject_type: 'service',
      p_subject_id: 'svc-1',
    })
  })

  it('holds consequential service-scoped knowledge when service grounding fails', async () => {
    groundedServiceResult = { ok: false, service: null, error: 'ambiguous service' }

    const outcome = await write(
      classification({
        risk: 'consequential',
        scope: { kind: 'standing', target: 'service', serviceName: 'Bimini Tour', dateISO: null },
        businessFact: { category: 'policy', text: 'Refunds require 14 days notice.' },
      })
    )

    expect(outcome.decision).toBe('candidate')
    expect(rpcName).toBeNull()
  })

  it('also holds low-risk service-scoped knowledge when grounding fails instead of widening it to workspace scope', async () => {
    groundedServiceResult = { ok: false, service: null, error: 'ambiguous service' }

    const outcome = await write(
      classification({
        risk: 'low',
        scope: { kind: 'standing', target: 'service', serviceName: 'Heritage Tour', dateISO: null },
        businessFact: { category: 'logistics', text: 'Guests meet by the pink building.' },
      }),
      { operatorText: 'For the Heritage Tour, guests meet by the pink building.' }
    )

    expect(outcome.decision).toBe('candidate')
    expect(outcome.reason).toContain('did not resolve')
    expect(rpcName).toBeNull()
  })

  it('maps founder corrections to founder authority', async () => {
    await write(classification(), { callerRole: 'founder' })
    expect(rpcParams).toMatchObject({ p_authority_kind: 'founder' })
  })

  it('surfaces typed RPC failures as errors instead of claiming a durable write', async () => {
    rpcError = { message: 'permission denied' }

    const outcome = await write()

    expect(outcome.decision).toBe('error')
    expect(outcome.reason).toContain('write_typed_business_memory_atomic failed')
  })
})