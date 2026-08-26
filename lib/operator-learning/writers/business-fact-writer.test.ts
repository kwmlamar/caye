import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let activeFacts: {
  id: string
  fact: string
  source: string
  expires_at: string | null
  canonical_key?: string | null
  service_id?: string | null
}[] = []
let conflictResult: { conflictId: string | null; resolution: 'supersede' | 'ambiguous' | null; checkFailed?: boolean } = {
  conflictId: null,
  resolution: null,
}
let conflictCtxSeen: { newFactScopeLabel?: string } | null = null
let conflictCandidatesSeen: { id: string; scopeLabel?: string }[] | null = null
let semanticMatchResult: { matchId: string | null } = { matchId: null }
let rpcParams: Record<string, unknown> | null = null
let rpcError: { message: string } | null = null
let rpcResponse: { id: string; created_at: string; superseded_id: string | null } = {
  id: 'fact-new',
  created_at: '2026-08-26T00:00:00Z',
  superseded_id: null,
}
let groundedServiceResult:
  | { ok: true; service: { id: string; name: string }; error: null }
  | { ok: false; service: null; error: string } = {
  ok: false,
  service: null,
  error: 'no lookup requested',
}
let scopedServices: { id: string; name: string }[] = []

vi.mock('@/lib/business-fact-conflict', () => ({
  findConflictingFact: async (
    _newFact: string,
    candidates: { id: string; scopeLabel?: string }[],
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
        return { select: () => ({ in: async () => ({ data: scopedServices, error: null }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
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

function call(
  c: ReturnType<typeof classification>,
  over: Partial<{ workspaceId: string; callerRole: string; operatorText: string }> = {}
) {
  return writeBusinessFact({
    workspaceId: 'ws-1',
    callerRole: 'owner',
    operatorText: 'default raw operator statement used by tests that do not care about grounding',
    classification: c,
    ...over,
  })
}

beforeEach(() => {
  activeFacts = []
  conflictResult = { conflictId: null, resolution: null }
  conflictCtxSeen = null
  conflictCandidatesSeen = null
  semanticMatchResult = { matchId: null }
  rpcParams = null
  rpcError = null
  rpcResponse = { id: 'fact-new', created_at: '2026-08-26T00:00:00Z', superseded_id: null }
  groundedServiceResult = { ok: false, service: null, error: 'no lookup requested' }
  scopedServices = []
})

describe('writeBusinessFact', () => {
  it('writes with no conflict as a plain append (Bimini: bottled water $2.50/guest)', async () => {
    const c = classification({
      canonicalKey: 'bottled-water-price',
      businessFact: { category: 'service_detail', text: 'Bottled water is $2.50 per guest, one bottle per person.' },
    })
    const outcome = await call(c)
    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({ p_canonical_key: 'bottled-water-price', p_source: 'owner-direct' })
  })

  it('supersedes an active conflicting fact when the judge says supersede (Juli King / payment policy pattern)', async () => {
    activeFacts = [
      { id: 'fact-old', fact: 'We accept cash, Zelle, or card.', source: 'owner-direct', expires_at: null },
    ]
    conflictResult = { conflictId: 'fact-old', resolution: 'supersede' }
    rpcResponse = { id: 'fact-new', created_at: '2026-08-26T00:00:00Z', superseded_id: 'fact-old' }

    const outcome = await call(classification())
    expect(outcome.decision).toBe('superseded_and_written')
    expect(rpcParams).toMatchObject({ p_supersede_id: 'fact-old' })
  })

  it('holds as a candidate on an ambiguous conflict rather than writing or superseding', async () => {
    activeFacts = [{ id: 'fact-old', fact: 'Tours run daily at 9am.', source: 'owner-direct', expires_at: null }]
    conflictResult = { conflictId: 'fact-old', resolution: 'ambiguous' }

    const outcome = await call(classification())
    expect(outcome.decision).toBe('candidate')
    expect(rpcParams).toBeNull()
  })

  it('fails closed (error, no write) when the conflict check itself fails', async () => {
    activeFacts = [{ id: 'fact-old', fact: 'Cash is not accepted.', source: 'owner-direct', expires_at: null }]
    conflictResult = { conflictId: null, resolution: null, checkFailed: true }

    const outcome = await call(classification())
    expect(outcome.decision).toBe('error')
    expect(rpcParams).toBeNull()
  })

  it('resolves and attaches service_id when scope.target is service and the lookup succeeds', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' }, error: null }
    const c = classification({
      scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini', dateISO: null },
    })
    await call(c)
    expect(rpcParams).toMatchObject({ p_service_id: 'svc-1' })
  })

  it('still writes workspace-wide (service_id null) when LOW-risk service resolution fails rather than blocking the save', async () => {
    groundedServiceResult = { ok: false, service: null, error: 'ambiguous' }
    const c = classification({
      risk: 'low',
      scope: { kind: 'standing', target: 'service', serviceName: 'Some Tour', dateISO: null },
    })
    const outcome = await call(c)
    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({ p_service_id: null })
  })

  // Deterministic destination resolution for consequential content — added
  // after the 2026-08-26 audit's re-review of the "confidence must never
  // itself be sufficient authority" invariant. Every other destination
  // (pricing, availability, contact) already refuses outright on a failed
  // service lookup regardless of risk; business_fact's low-risk fallback
  // (service_id null, workspace-wide) is fine for an ordinary fact, but
  // silently broadening a CONSEQUENTIAL service-specific policy to
  // workspace-wide because the name didn't resolve is exactly the kind of
  // scope-widening a deterministic gate — not a confidence threshold — must
  // catch.
  it('holds as a candidate (does not write workspace-wide) when CONSEQUENTIAL service-scoped resolution fails', async () => {
    groundedServiceResult = { ok: false, service: null, error: 'ambiguous match for "Full Bimini"' }
    const c = classification({
      risk: 'consequential',
      scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini', dateISO: null },
      businessFact: { category: 'policy', text: 'Refunds for this tour now require 14 days notice.' },
    })
    const outcome = await call(c)
    expect(outcome.decision).toBe('candidate')
    expect(rpcParams).toBeNull()
  })

  it('still writes consequential content when service resolution succeeds', async () => {
    groundedServiceResult = { ok: true, service: { id: 'svc-1', name: 'Full Bimini Experience' }, error: null }
    const c = classification({
      risk: 'consequential',
      scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini', dateISO: null },
      businessFact: { category: 'policy', text: 'Refunds for this tour now require 14 days notice.' },
    })
    const outcome = await call(c)
    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({ p_service_id: 'svc-1' })
  })

  it('surfaces an RPC error (e.g. concurrent-write constraint violation) as decision=error, not a silent success', async () => {
    rpcError = { message: 'duplicate key value violates unique constraint' }
    const outcome = await call(classification())
    expect(outcome.decision).toBe('error')
  })

  // Real scope-correctness gap found 2026-08-26: resolveGroundedService now
  // rejects when the service the classifier claims resolves confidently but
  // is never mentioned in what the operator actually said — proves
  // business-fact-writer.ts propagates that rejection as a hold, same as an
  // ordinary resolution failure, rather than treating "the string-match
  // succeeded" as good enough on its own.
  it('holds as a candidate when resolveGroundedService rejects a stale-context mis-attribution', async () => {
    groundedServiceResult = { ok: false, service: null, error: 'resolved to "Full Bimini Experience" but none of its distinguishing words appear in what the operator actually said' }
    const c = classification({
      risk: 'consequential',
      scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini Experience', dateISO: null },
      businessFact: { category: 'policy', text: 'Refunds for this tour now require 14 days notice.' },
    })
    const outcome = await call(c, {})
    expect(outcome.decision).toBe('candidate')
    expect(rpcParams).toBeNull()
  })

  // Real production ambiguity (2026-08-26 audit): "the meeting point for the
  // Heritage Tour is the pink building by the dock" (service-scoped,
  // 2026-06-25) and "the pickup location for all tours is the Casino Tram
  // Stop" (workspace-wide, 2026-08-26) are BOTH still active today. Proves
  // the writer enriches the conflict judge with scope labels rather than
  // handing it bare, scope-blind text.
  it('passes scope labels to the conflict judge for both the new fact and existing scoped facts (real pink-building / Casino-Tram-Stop case)', async () => {
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
    conflictResult = { conflictId: null, resolution: null }
    const c = classification({
      canonicalKey: 'all-tours-pickup-location',
      scope: { kind: 'standing', target: 'workspace', serviceName: null, dateISO: null },
      businessFact: { category: 'logistics', text: 'The pickup location for all tours is the Casino Tram Stop.' },
    })

    await call(c)

    expect(conflictCtxSeen).toMatchObject({ newFactScopeLabel: 'workspace-wide (applies to all services)' })
    expect(conflictCandidatesSeen).toMatchObject([
      { id: 'fact-pink-building', scopeLabel: 'specific to North Bimini Heritage Tour' },
    ])
  })

  // Real Bimini production incident, found during the 2026-08-26 historical-
  // learning audit: two active, redundant business_facts rows about payment
  // method existed simultaneously ("card only... cash and Zelle not
  // accepted" from 2026-08-10, and "only accepts online payment... do not
  // mention Cash or Zelle" from 2026-08-25) — neither superseded the other,
  // because they don't literally contradict (both forbid cash/Zelle), so
  // findConflictingFact correctly found no conflict. A classifier minting a
  // fresh canonicalKey on each independent call would reproduce this exact
  // bug. This proves the semantic-dedup fallback catches what the
  // contradiction judge and a differently-worded canonicalKey both miss.
  it('supersedes a same-topic-but-not-contradictory active fact via semantic match, reusing ITS canonical_key (real payment-policy duplicate)', async () => {
    activeFacts = [
      {
        id: 'fact-2026-08-10',
        fact: 'All payments are made in advance by card only. An invoice is sent to the customer, and upon receipt of payment, additional tour information is provided. Cash and Zelle are not accepted.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: 'payment-method-card-only',
      },
    ]
    conflictResult = { conflictId: null, resolution: null } // no literal contradiction — both forbid cash/Zelle
    semanticMatchResult = { matchId: 'fact-2026-08-10' } // same-topic judge catches it anyway
    rpcResponse = { id: 'fact-2026-08-25', created_at: '2026-08-25T00:07:00Z', superseded_id: 'fact-2026-08-10' }

    const c = classification({
      canonicalKey: 'online-payment-only', // a DIFFERENT key than the existing fact's — simulates the classifier not reproducing the same string
      businessFact: {
        category: 'policy',
        text: 'Bimini Island Tours only accepts online payment. Do not offer or mention Cash or Zelle as payment options in any customer-facing communication.',
      },
    })
    const outcome = await call(c)

    expect(outcome.decision).toBe('superseded_and_written')
    expect(rpcParams).toMatchObject({
      p_supersede_id: 'fact-2026-08-10',
      // Joins the EXISTING fact's canonical_key rather than starting a
      // parallel chain under the classifier's own (different) key.
      p_canonical_key: 'payment-method-card-only',
    })
  })

  it('does not touch anything when neither the contradiction judge nor the semantic-dedup judge finds a match', async () => {
    activeFacts = [{ id: 'fact-old', fact: 'The dock closes at 5pm.', source: 'owner-direct', expires_at: null, canonical_key: 'dock-hours' }]
    conflictResult = { conflictId: null, resolution: null }
    semanticMatchResult = { matchId: null }

    const outcome = await call(classification())
    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({ p_supersede_id: null, p_canonical_key: 'payment-method' })
  })
})

// ── Canonical-key / paraphrase behavior (task item 4) ──────────────────────
//
// The router does NOT decide paraphrase identity itself — it defers
// entirely to the semantic-dedup judge (findSemanticFactMatch), the same
// judge business-fact-suggestions.ts already trusts for "is this the same
// fact reworded". These tests prove the writer correctly acts on whatever
// that judge decides in both directions: collapse when told to, and
// — just as important — do NOT collapse when the judge says the
// distinction is real.
describe('writeBusinessFact — canonical-key stability across paraphrases', () => {
  const existingOnlineOnly = {
    id: 'fact-online-only',
    fact: 'We only take online payments.',
    source: 'owner-direct',
    expires_at: null,
    canonical_key: 'payment-method',
  }

  // "we only take online payments" / "payment is online only" / "no cash or
  // Zelle" / "customers must pay using the invoice link" all describe the
  // SAME underlying policy. The judge deciding they match is what the
  // router relies on — proven here for each paraphrase independently.
  it.each([
    'Payment is online only.',
    'No cash or Zelle.',
    'Customers must pay using the invoice link.',
  ])('paraphrase "%s" chains onto the existing payment-method fact when the semantic judge says they match', async (paraphrase) => {
    activeFacts = [existingOnlineOnly]
    conflictResult = { conflictId: null, resolution: null }
    semanticMatchResult = { matchId: 'fact-online-only' }
    rpcResponse = { id: 'fact-new', created_at: '2026-08-26T00:00:00Z', superseded_id: 'fact-online-only' }

    const c = classification({
      canonicalKey: `paraphrase-key-${paraphrase.length}`, // deliberately a DIFFERENT key each time
      businessFact: { category: 'policy', text: paraphrase },
    })
    const outcome = await call(c)

    expect(outcome.decision).toBe('superseded_and_written')
    expect(rpcParams).toMatchObject({ p_supersede_id: 'fact-online-only', p_canonical_key: 'payment-method' })
  })

  // The task's explicit warning: "card only" and "online payment only" must
  // NOT be blindly collapsed if the distinction could matter operationally
  // (card-present vs. card-not-present is a real operational difference).
  // The router doesn't hard-code this distinction — it defers to the judge.
  // This proves that when the judge decides the two are NOT the same fact,
  // the writer respects that and does not force a merge.
  it('does NOT collapse "card only" into "online payment only" when the semantic judge decides the distinction is real', async () => {
    activeFacts = [
      {
        id: 'fact-card-only',
        fact: 'All payments are made in advance by card only.',
        source: 'owner-direct',
        expires_at: null,
        canonical_key: 'payment-method-card',
      },
    ]
    conflictResult = { conflictId: null, resolution: null } // not a literal contradiction
    semanticMatchResult = { matchId: null } // judge: these are NOT the same fact — a real distinction

    const c = classification({
      canonicalKey: 'payment-method-online',
      businessFact: { category: 'policy', text: 'Online payment only.' },
    })
    const outcome = await call(c)

    // Written as its OWN independent fact, under its OWN key — not forced
    // to supersede the card-only fact.
    expect(outcome.decision).toBe('written')
    expect(rpcParams).toMatchObject({ p_supersede_id: null, p_canonical_key: 'payment-method-online' })
  })
})
