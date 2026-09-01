import { describe, expect, it, vi } from 'vitest'

import {
  CONTESTED_RECOMMENDATION_CONFIDENCE_CAP,
  boundRecommendationCandidates,
  classifyRecommendationTrigger,
  recommendationTriggerFingerprint,
  runMaterialRecommendationRuntime,
  validateRecommendationProposal,
  type RecommendationCandidate,
  type RecommendationProposal,
  type RecommendationRuntimeStore,
} from './runtime'

function candidate(overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return {
    goal: {
      id: 'goal-1',
      title: 'Improve Caye unit economics',
      description: 'Grow durable margin while preserving reliability.',
      status: 'active',
      supersededAt: null,
    },
    intelligence: {
      id: 'intel-1',
      domain: 'ai',
      claim: 'Frontier inference cost fell materially this month.',
      status: 'current',
      confidence: 0.86,
      materiality: 0.88,
      validUntil: null,
      provenance: { kind: 'cross-domain-synthesis', connectionKind: 'strategic' },
    },
    goalImpact: {
      mechanism: 'Lower inference cost reduces cost per autonomous research cycle.',
      impact: 'More continuous scanning is affordable at the same gross margin.',
      confidence: 0.84,
      evidenceClaimIds: ['claim-1', 'claim-2'],
      synthesisFingerprint: 'synthesis-v1',
    },
    beliefRevisions: [],
    hasCanonicalGoalImpact: true,
    ...overrides,
  }
}

function materialRevisionCandidate(overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
  return candidate({
    beliefRevisions: [{
      id: 'revision-1',
      priorConfidence: 0.58,
      revisedConfidence: 0.79,
      evidenceRole: 'supports',
      createdAt: '2026-08-31T20:00:00.000Z',
    }],
    ...overrides,
  })
}

function proposal(overrides: Partial<RecommendationProposal> = {}): RecommendationProposal {
  return {
    title: 'Increase continuous opportunity scanning',
    proposedAction: 'Increase the continuous opportunity scan cadence for the next seven days and measure qualified findings per dollar.',
    rationale: 'Lower inference cost directly reduces the cost of the research cycles that support the active unit-economics goal, making a bounded cadence increase worth testing.',
    expectedOutcome: 'More qualified opportunities discovered without reducing gross margin.',
    expectedImpact: 'High positive impact on research coverage and unit economics.',
    urgency: 'high',
    reversibility: 'easy',
    risk: 'low',
    confidence: 0.8,
    requiredAuthority: { principalType: 'personal', principalRef: null, resolvedBy: 'unresolved' },
    supportingIntelligenceIds: ['intel-1'],
    supportingClaimIds: ['claim-1', 'claim-2'],
    supportingBeliefRevisionIds: [],
    ...overrides,
  }
}

function storeFor(candidates: RecommendationCandidate[], duplicate = false) {
  const persisted: unknown[] = []
  const store: RecommendationRuntimeStore = {
    loadCandidates: vi.fn(async () => candidates),
    hasProposalFingerprint: vi.fn(async () => duplicate),
    persist: vi.fn(async (input) => {
      persisted.push(input)
      return input
    }),
  }
  return { store, persisted }
}

describe('material intelligence recommendation runtime', () => {
  it('creates one grounded recommendation for a material belief change', async () => {
    const c = materialRevisionCandidate()
    const { store, persisted } = storeFor([c])
    const proposer = vi.fn(async () => proposal({ supportingBeliefRevisionIds: ['revision-1'] }))

    const result = await runMaterialRecommendationRuntime({ store, proposer })

    expect(result).toMatchObject({ candidates: 1, proposed: 1, persisted: 1, rejected: 0 })
    expect(proposer).toHaveBeenCalledTimes(1)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      goalId: 'goal-1',
      intelligenceItemIds: ['intel-1'],
      evidenceClaimIds: ['claim-1', 'claim-2'],
      beliefRevisionIds: ['revision-1'],
    })
  })

  it('creates none for a weak change', async () => {
    const weak = candidate({
      intelligence: {
        ...candidate().intelligence,
        materiality: 0.35,
        provenance: { kind: 'cross-domain-synthesis', connectionKind: 'weak-signal-pattern' },
      },
      goalImpact: { ...candidate().goalImpact, confidence: 0.55 },
      beliefRevisions: [{
        id: 'revision-weak',
        priorConfidence: 0.5,
        revisedConfidence: 0.54,
        evidenceRole: 'supports',
        createdAt: '2026-08-31T20:00:00.000Z',
      }],
    })
    const { store } = storeFor([weak])
    const proposer = vi.fn(async () => proposal())

    expect(await runMaterialRecommendationRuntime({ store, proposer })).toMatchObject({ candidates: 0, persisted: 0 })
    expect(proposer).not.toHaveBeenCalled()
  })

  it('creates none for an inactive goal', () => {
    const inactive = candidate({ goal: { ...candidate().goal, status: 'paused' } })
    expect(classifyRecommendationTrigger(inactive)).toBeNull()
  })

  it('suppresses a duplicate before asking the model again', async () => {
    const c = candidate()
    const { store } = storeFor([c], true)
    const proposer = vi.fn(async () => proposal())

    const result = await runMaterialRecommendationRuntime({ store, proposer })
    expect(result).toMatchObject({ candidates: 1, proposed: 0, persisted: 0, duplicateSuppressed: 1 })
    expect(proposer).not.toHaveBeenCalled()
  })

  it('lowers confidence and retains uncertainty for contradictory evidence', () => {
    const contested = candidate({
      intelligence: { ...candidate().intelligence, status: 'contested' },
      beliefRevisions: [{
        id: 'revision-contradiction',
        priorConfidence: 0.88,
        revisedConfidence: 0.71,
        evidenceRole: 'contradicts',
        createdAt: '2026-08-31T20:00:00.000Z',
      }],
    })
    const decision = classifyRecommendationTrigger(contested)
    expect(decision?.kind).toBe('contradiction-resolution')

    const validated = validateRecommendationProposal(contested, decision!, proposal({
      confidence: 0.9,
      supportingBeliefRevisionIds: ['revision-contradiction'],
      rationale: 'The changed cost evidence affects the active objective and makes a bounded cadence experiment worth evaluating now.',
    }))

    expect(validated.confidence).toBeLessThanOrEqual(CONTESTED_RECOMMENDATION_CONFIDENCE_CAP)
    expect(validated.rationale).toMatch(/uncertainty|contested|contradict/i)
  })

  it('does not recommend across an unrelated domain without a canonical goal impact', () => {
    const unrelated = candidate({
      intelligence: { ...candidate().intelligence, domain: 'geopolitics' },
      hasCanonicalGoalImpact: false,
    })
    expect(classifyRecommendationTrigger(unrelated)).toBeNull()
  })

  it('accepts high materiality with an active goal and explicit mechanism', () => {
    const c = candidate()
    const decision = classifyRecommendationTrigger(c)
    expect(decision).not.toBeNull()
    const validated = validateRecommendationProposal(c, decision!, proposal())
    expect(validated.goalId).toBe('goal-1')
    expect(validated.recommendation).toContain('seven days')
    expect(validated.expectedImpact).toContain('High positive impact')
  })

  it('uses a stable trigger fingerprint so unchanged synthesis does not re-propose', () => {
    const c = candidate()
    const first = classifyRecommendationTrigger(c)!
    const second = classifyRecommendationTrigger(candidate())!
    expect(recommendationTriggerFingerprint(c, first)).toBe(recommendationTriggerFingerprint(candidate(), second))
  })

  it('requires grounded evidence IDs from the bounded candidate', () => {
    const c = candidate()
    const decision = classifyRecommendationTrigger(c)!
    expect(() => validateRecommendationProposal(c, decision, proposal({ supportingClaimIds: ['claim-unrelated'] })))
      .toThrow('ungrounded evidence claims')

    const validated = validateRecommendationProposal(c, decision, proposal())
    expect(validated.intelligenceItemIds).toEqual(['intel-1'])
    expect(validated.evidenceClaimIds).toEqual(['claim-1', 'claim-2'])
  })

  it('hard-caps the recommendation candidate neighborhood', () => {
    const many = Array.from({ length: 20 }, (_, index) => candidate({
      intelligence: { ...candidate().intelligence, id: `intel-${index}` },
    }))
    expect(boundRecommendationCandidates(many)).toHaveLength(6)
  })
})
