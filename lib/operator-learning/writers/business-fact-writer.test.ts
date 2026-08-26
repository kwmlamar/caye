import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let activeFacts: { id: string; fact: string; source: string; expires_at: string | null }[] = []
let conflictResult: { conflictId: string | null; resolution: 'supersede' | 'ambiguous' | null; checkFailed?: boolean } = {
  conflictId: null,
  resolution: null,
}
let rpcParams: Record<string, unknown> | null = null
let rpcError: { message: string } | null = null
let rpcResponse: { id: string; created_at: string; superseded_id: string | null } = {
  id: 'fact-new',
  created_at: '2026-08-26T00:00:00Z',
  superseded_id: null,
}
let serviceLookupResult: { ok: true; service: { id: string; name: string } } | { ok: false; error: string } = {
  ok: false,
  error: 'no lookup requested',
}

vi.mock('@/lib/business-fact-conflict', () => ({
  findConflictingFact: async () => conflictResult,
}))

vi.mock('@/lib/caye-agent/tools/_catalog-helpers', () => ({
  resolveServiceByName: async () => serviceLookupResult,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'business_facts') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            is: async () => ({ data: activeFacts, error: null }),
          }),
        }),
      }
    },
    rpc(fn: string, params: Record<string, unknown>) {
      if (fn !== 'write_business_fact_atomic') throw new Error(`unexpected rpc: ${fn}`)
      rpcParams = params
      return {
        single: async () => (rpcError ? { data: null, error: rpcError } : { data: rpcResponse, error: null }),
      }
    },
  }),
}))

const { writeBusinessFact } = await import('./business-fact-writer')
const { validateClassification } = await import('../schema')

function classification(overrides: Record<string, unknown> = {}) {
  const res = validateClassification({
    learnable: true,
    explicitness: 'explicit_correction',
    scope: { kind: 'standing', target: 'workspace', serviceName: null, dateISO: null },
    risk: 'low',
    destination: 'business_fact',
    canonicalKey: 'payment-method',
    confidence: 0.9,
    rationale: 'owner stated payment policy',
    businessFact: { category: 'policy', text: 'We only use online payment.' },
    ...overrides,
  })
  if (!res.ok) throw new Error(`bad test fixture: ${res.reason}`)
  return res.value
}

beforeEach(() => {
  activeFacts = []
  conflictResult = { conflictId: null, resolution: null }
  rpcParams = null
  rpcError = null
  rpcResponse = { id: 'fact-new', created_at: '2026-08-26T00:00:00Z', superseded_id: null }
  serviceLookupResult = { ok: false, error: 'no lookup requested' }
})

describe('writeBusinessFact', () => {
  it('writes with no conflict as a plain append (Bimini: bottled water $2.50/guest)', async () => {
    const c = classification({
      canonicalKey: 'bottled-water-price',
      businessFact: { category: 'service_detail', text: 'Bottled water is $2.50 per guest, one bottle per person.' },
    })
    const outcome = await writeBusinessFact({ workspaceId: 'ws-1', callerRole: 'owner', classification: c })
    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({ p_canonical_key: 'bottled-water-price', p_source: 'owner-direct' })
  })

  it('supersedes an active conflicting fact when the judge says supersede (Juli King / payment policy pattern)', async () => {
    activeFacts = [
      { id: 'fact-old', fact: 'We accept cash, Zelle, or card.', source: 'owner-direct', expires_at: null },
    ]
    conflictResult = { conflictId: 'fact-old', resolution: 'supersede' }
    rpcResponse = { id: 'fact-new', created_at: '2026-08-26T00:00:00Z', superseded_id: 'fact-old' }

    const outcome = await writeBusinessFact({ workspaceId: 'ws-1', callerRole: 'owner', classification: classification() })
    expect(outcome.decision).toBe('superseded_and_written')
    expect(rpcParams).toMatchObject({ p_supersede_id: 'fact-old' })
  })

  it('holds as a candidate on an ambiguous conflict rather than writing or superseding', async () => {
    activeFacts = [{ id: 'fact-old', fact: 'Tours run daily at 9am.', source: 'owner-direct', expires_at: null }]
    conflictResult = { conflictId: 'fact-old', resolution: 'ambiguous' }

    const outcome = await writeBusinessFact({ workspaceId: 'ws-1', callerRole: 'owner', classification: classification() })
    expect(outcome.decision).toBe('candidate')
    expect(rpcParams).toBeNull()
  })

  it('fails closed (error, no write) when the conflict check itself fails', async () => {
    activeFacts = [{ id: 'fact-old', fact: 'Cash is not accepted.', source: 'owner-direct', expires_at: null }]
    conflictResult = { conflictId: null, resolution: null, checkFailed: true }

    const outcome = await writeBusinessFact({ workspaceId: 'ws-1', callerRole: 'owner', classification: classification() })
    expect(outcome.decision).toBe('error')
    expect(rpcParams).toBeNull()
  })

  it('resolves and attaches service_id when scope.target is service and the lookup succeeds', async () => {
    serviceLookupResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' } }
    const c = classification({
      scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini', dateISO: null },
    })
    await writeBusinessFact({ workspaceId: 'ws-1', callerRole: 'owner', classification: c })
    expect(rpcParams).toMatchObject({ p_service_id: 'svc-1' })
  })

  it('still writes workspace-wide (service_id null) when service resolution fails rather than blocking the save', async () => {
    serviceLookupResult = { ok: false, error: 'ambiguous' }
    const c = classification({
      scope: { kind: 'standing', target: 'service', serviceName: 'Some Tour', dateISO: null },
    })
    const outcome = await writeBusinessFact({ workspaceId: 'ws-1', callerRole: 'owner', classification: c })
    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({ p_service_id: null })
  })

  it('surfaces an RPC error (e.g. concurrent-write constraint violation) as decision=error, not a silent success', async () => {
    rpcError = { message: 'duplicate key value violates unique constraint' }
    const outcome = await writeBusinessFact({ workspaceId: 'ws-1', callerRole: 'owner', classification: classification() })
    expect(outcome.decision).toBe('error')
  })
})
