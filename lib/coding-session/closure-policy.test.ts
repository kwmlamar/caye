import { describe, expect, it } from 'vitest'
import { assessSoftwareLearningEvidence, codingSessionBranch, evaluateEngineeringClosure } from './closure-policy'

const base = { repository: 'kwmlamar/caye', baseBranch: 'main', workBranch: 'caye/coding-session/11111111-1111-4111-8111-111111111111', testPassed: true, buildPassed: true, branchPushPassed: true, productionObserved: false }

const learningBase = {
  workspaceId: '22222222-2222-4222-8222-222222222222',
  learningKey: 'direct:epistemic-provenance',
  verdict: 'production_verified' as const,
  environment: 'production' as const,
  productionEvidenceSource: 'production' as const,
  hasExecutionEvidence: true,
  hasObservedOutcome: true,
  matchingIndependentProductionOutcomes: 1,
}

describe('engineering coding-session closure', () => {
  it('records passing branch evidence without claiming production success', () => { expect(evaluateEngineeringClosure(base)).toMatchObject({ verdict: 'branch_verified', comparison: 'confirmed', environment: 'branch', productionVerified: false, evidenceSources: ['branch','test'] }) })
  it('fails closed for the wrong repository', () => { expect(evaluateEngineeringClosure({ ...base, repository: 'attacker/repo' })).toMatchObject({ verdict: 'failed', comparison: 'contradicted', productionVerified: false }) })
  it('refuses execution on main', () => { expect(evaluateEngineeringClosure({ ...base, workBranch: 'main' })).toMatchObject({ verdict: 'failed', comparison: 'contradicted', productionVerified: false }) })
  it('does not call incomplete branch evidence successful', () => { expect(evaluateEngineeringClosure({ ...base, buildPassed: null })).toMatchObject({ verdict: 'inconclusive', comparison: 'inconclusive', productionVerified: false }) })
  it('treats a wrong prediction and bad production outcome as contradicted', () => { expect(evaluateEngineeringClosure({ ...base, productionObserved: true, productionHealthy: false, productionEvidenceSource: 'production' })).toMatchObject({ verdict: 'failed', comparison: 'contradicted', environment: 'production', productionVerified: false }) })
  it('keeps passing tests branch-only when production effect is absent', () => { expect(evaluateEngineeringClosure(base)).toMatchObject({ verdict: 'branch_verified', environment: 'branch', productionVerified: false }) })
  it('rejects simulated evidence presented as observed production', () => { expect(evaluateEngineeringClosure({ ...base, productionObserved: true, productionHealthy: true, productionEvidenceSource: 'simulated' })).toMatchObject({ verdict: 'inconclusive', comparison: 'inconclusive', productionVerified: false }) })
  it('rejects branch-only evidence presented as observed production', () => { expect(evaluateEngineeringClosure({ ...base, productionObserved: true, productionHealthy: true, productionEvidenceSource: 'branch' })).toMatchObject({ verdict: 'inconclusive', comparison: 'inconclusive', productionVerified: false }) })
  it('requires independent production evidence for production verification', () => {
    expect(evaluateEngineeringClosure({ ...base, productionObserved: true, productionHealthy: true })).toMatchObject({ verdict: 'inconclusive', productionVerified: false })
    expect(evaluateEngineeringClosure({ ...base, productionObserved: true, productionHealthy: true, productionEvidenceSource: 'production' })).toMatchObject({ verdict: 'production_verified', environment: 'production', productionVerified: true })
  })
  it('derives only isolated branches from valid session ids', () => { expect(codingSessionBranch('11111111-1111-4111-8111-111111111111')).toBe('caye/coding-session/11111111-1111-4111-8111-111111111111'); expect(() => codingSessionBranch('main')).toThrow('Invalid coding session id') })
})

describe('software engineering learning evidence', () => {
  it('keeps one production outcome as a candidate, not reusable learning', () => {
    expect(assessSoftwareLearningEvidence(learningBase)).toMatchObject({ candidate: true, reusable: false, minimumEvidenceThreshold: 2 })
  })

  it('requires repeated independent matching production outcomes', () => {
    expect(assessSoftwareLearningEvidence({ ...learningBase, matchingIndependentProductionOutcomes: 2 })).toMatchObject({ candidate: true, reusable: true, minimumEvidenceThreshold: 2 })
  })

  it('does not count conflicting outcomes toward the matching threshold', () => {
    expect(assessSoftwareLearningEvidence({ ...learningBase, verdict: 'failed', matchingIndependentProductionOutcomes: 1 })).toMatchObject({ candidate: true, reusable: false })
  })

  it('rejects branch, simulated, and incomplete evidence from the learning audit', () => {
    expect(assessSoftwareLearningEvidence({ ...learningBase, environment: 'branch', productionEvidenceSource: 'branch' })).toMatchObject({ candidate: false, reusable: false })
    expect(assessSoftwareLearningEvidence({ ...learningBase, productionEvidenceSource: 'simulated' })).toMatchObject({ candidate: false, reusable: false })
    expect(assessSoftwareLearningEvidence({ ...learningBase, hasObservedOutcome: false })).toMatchObject({ candidate: false, reusable: false })
  })

  it('does not mislabel founder/global sessions as workspace learning', () => {
    expect(assessSoftwareLearningEvidence({ ...learningBase, workspaceId: null })).toMatchObject({ candidate: false, reusable: false })
  })
})
