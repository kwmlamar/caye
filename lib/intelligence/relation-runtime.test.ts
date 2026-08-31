import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))

import {
  boundCandidates,
  computeBeliefRevision,
  evidenceIdentity,
  rankCandidate,
  validateRelationProposal,
  type ClaimSnapshot,
  type IntelligenceItemSnapshot,
  type RelationProposal,
} from './relation-runtime'

function item(overrides: Partial<IntelligenceItemSnapshot> = {}): IntelligenceItemSnapshot {
  return {
    id: 'item-new',
    workspace_id: 'workspace-a',
    scope: 'workspace',
    domain: 'ai',
    topic: 'frontier model economics',
    canonical_claim: 'Inference costs are falling for frontier models.',
    semantic_key: 'frontier-costs',
    confidence: 0.6,
    materiality: 0.8,
    relevance: 0.8,
    observed_at: '2026-08-31T18:00:00.000Z',
    valid_from: '2026-08-31T18:00:00.000Z',
    valid_until: null,
    status: 'current',
    provenance: {},
    ...overrides,
  }
}

function claim(id: string, url: string, overrides: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
  return {
    id,
    semantic_key: id,
    observed_at: '2026-08-31T18:00:00.000Z',
    provenance: { canonicalUrl: url },
    ...overrides,
  }
}

function proposal(overrides: Partial<RelationProposal> = {}): RelationProposal {
  return {
    fromItemId: 'item-new',
    toItemId: 'item-old',
    relationType: 'corroborates',
    rationale: 'Independent evidence supports the existing belief.',
    supportingResearchClaimIds: ['claim-a', 'claim-b'],
    confidence: 0.82,
    ...overrides,
  }
}

describe('bounded intelligence relation policy', () => {
  it('rejects unrelated items even when their prose is semantically similar', () => {
    const newItem = item()
    const unrelated = item({
      id: 'item-unrelated',
      domain: 'career',
      topic: 'frontier model economics jobs',
      canonical_claim: 'Inference costs are falling for frontier models and hiring may change.',
    })

    expect(rankCandidate(newItem, unrelated, 0, false)).toBeNull()
  })

  it('hard-caps and deterministically ranks the candidate neighborhood', () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      item: item({ id: `candidate-${index}`, observed_at: `2026-08-${String((index % 28) + 1).padStart(2, '0')}T18:00:00.000Z` }),
      score: index / 40,
      reasons: ['same_domain'],
      claimIds: [],
    }))

    const bounded = boundCandidates(candidates, 100)
    expect(bounded).toHaveLength(16)
    expect(bounded[0].score).toBeGreaterThanOrEqual(bounded.at(-1)!.score)
  })

  it('treats duplicate rows from the same article as one independent evidence identity', () => {
    const first = claim('claim-a', 'https://example.com/report')
    const duplicate = claim('claim-b', 'https://example.com/report')

    expect(evidenceIdentity(first)).toBe(evidenceIdentity(duplicate))
    expect(computeBeliefRevision({
      relationType: 'corroborates',
      relationConfidence: 0.9,
      independentEvidence: new Set([evidenceIdentity(first), evidenceIdentity(duplicate)]).size,
      priorConfidence: 0.55,
      targetMateriality: 0.9,
    })).toBeNull()
  })

  it('does not let a weak single-source contradiction swing confidence', () => {
    expect(computeBeliefRevision({
      relationType: 'contradicts',
      relationConfidence: 0.95,
      independentEvidence: 1,
      priorConfidence: 0.8,
      targetMateriality: 1,
    })).toBeNull()
  })

  it('permits a bounded upward revision for real independent corroboration', () => {
    const revision = computeBeliefRevision({
      relationType: 'corroborates',
      relationConfidence: 0.9,
      independentEvidence: 3,
      priorConfidence: 0.55,
      targetMateriality: 1,
    })

    expect(revision).not.toBeNull()
    expect(revision!.delta).toBeGreaterThanOrEqual(0.025)
    expect(revision!.delta).toBeLessThanOrEqual(0.08)
    expect(revision!.revisedConfidence).toBeGreaterThan(0.55)
    expect(revision!.role).toBe('supports')
  })

  it('accepts supersession only when the proposed superseding item is newer', () => {
    const newer = item({ id: 'item-new', observed_at: '2026-08-31T18:00:00.000Z' })
    const older = item({ id: 'item-old', observed_at: '2026-08-01T18:00:00.000Z' })
    const claims = new Map<string, ClaimSnapshot>([
      ['claim-a', claim('claim-a', 'https://a.example/report')],
      ['claim-b', claim('claim-b', 'https://b.example/report')],
    ])

    expect(() => validateRelationProposal({
      proposal: proposal({ relationType: 'supersedes' }),
      newItem: newer,
      candidate: older,
      allowedClaimIds: new Set(claims.keys()),
      claimsById: claims,
    })).not.toThrow()

    expect(() => validateRelationProposal({
      proposal: proposal({
        fromItemId: 'item-old',
        toItemId: 'item-new',
        relationType: 'supersedes',
      }),
      newItem: newer,
      candidate: older,
      allowedClaimIds: new Set(claims.keys()),
      claimsById: claims,
    })).toThrow('supersession requires newer evidence')
  })

  it('rejects an attempted cross-workspace edge', () => {
    const claims = new Map<string, ClaimSnapshot>([['claim-a', claim('claim-a', 'https://a.example/report')]])
    expect(() => validateRelationProposal({
      proposal: proposal({ supportingResearchClaimIds: ['claim-a'] }),
      newItem: item({ id: 'item-new', workspace_id: 'workspace-a' }),
      candidate: item({ id: 'item-old', workspace_id: 'workspace-b' }),
      allowedClaimIds: new Set(['claim-a']),
      claimsById: claims,
    })).toThrow('cross-scope or cross-workspace')
  })

  it('rejects an arbitrary research claim that does not ground either endpoint', () => {
    const claims = new Map<string, ClaimSnapshot>([
      ['claim-a', claim('claim-a', 'https://a.example/report')],
      ['claim-arbitrary', claim('claim-arbitrary', 'https://unrelated.example/report')],
    ])
    expect(() => validateRelationProposal({
      proposal: proposal({ supportingResearchClaimIds: ['claim-a', 'claim-arbitrary'] }),
      newItem: item({ id: 'item-new' }),
      candidate: item({ id: 'item-old' }),
      allowedClaimIds: new Set(['claim-a']),
      claimsById: claims,
    })).toThrow('arbitrary or ungrounded research claim')
  })

  it('rejects causal overclaim without strong independent evidence', () => {
    const duplicateA = claim('claim-a', 'https://example.com/one-report')
    const duplicateB = claim('claim-b', 'https://example.com/one-report')
    const claims = new Map<string, ClaimSnapshot>([['claim-a', duplicateA], ['claim-b', duplicateB]])

    expect(() => validateRelationProposal({
      proposal: proposal({ relationType: 'causes', confidence: 0.99 }),
      newItem: item({ id: 'item-new', observed_at: '2026-08-01T18:00:00.000Z', valid_from: '2026-08-01T18:00:00.000Z' }),
      candidate: item({ id: 'item-old', observed_at: '2026-08-31T18:00:00.000Z', valid_from: '2026-08-31T18:00:00.000Z' }),
      allowedClaimIds: new Set(claims.keys()),
      claimsById: claims,
    })).toThrow('causal relation rejected')
  })

  it('produces the same canonical relation tuple on an idempotent rerun', () => {
    const claims = new Map<string, ClaimSnapshot>([
      ['claim-a', claim('claim-a', 'https://a.example/report')],
      ['claim-b', claim('claim-b', 'https://b.example/report')],
    ])
    const args = {
      proposal: proposal(),
      newItem: item({ id: 'item-new' }),
      candidate: item({ id: 'item-old' }),
      allowedClaimIds: new Set(claims.keys()),
      claimsById: claims,
    }

    const first = validateRelationProposal(args)
    const rerun = validateRelationProposal(args)
    expect([first.fromItemId, first.toItemId, first.relationType]).toEqual([rerun.fromItemId, rerun.toItemId, rerun.relationType])
    // upsert_grounded_intelligence_relation has a unique canonical tuple on these fields,
    // so identical validated reruns resolve to the same relation row rather than fan out.
  })
})
