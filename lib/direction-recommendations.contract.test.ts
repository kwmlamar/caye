import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const autonomyRoute = read('app/api/founder/autonomy-status/route.ts')
const decisionRoute = read('app/api/founder/recommendation-decision/route.ts')
const card = read('components/dashboard/founder-home/RecommendationCard.tsx')
const surface = read('components/dashboard/founder-home/AutonomyStatus.tsx')

describe('Direction recommendation + decision mission-control contract', () => {
  it('reads canonical recommendations, evidence, and canonical recommendation decisions', () => {
    expect(autonomyRoute).toMatch(/from\('caye_recommendations'\)/)
    expect(autonomyRoute).toMatch(/from\('caye_recommendation_claims'\)/)
    expect(autonomyRoute).toMatch(/from\('caye_recommendation_decisions'\)/)
    expect(autonomyRoute).toMatch(/recommendation_fingerprint/)
  })

  it('pins founder decisions to the current recommendation fingerprint and canonical writer', () => {
    expect(decisionRoute).toMatch(/recommendation\.fingerprint !== body\.recommendationFingerprint/)
    expect(decisionRoute).toMatch(/recordRecommendationDecision/)
    expect(decisionRoute).toMatch(/from\('caye_recommendation_decisions'\)/)
    expect(decisionRoute).not.toMatch(/recordBusinessDecision/)
  })

  it('does not turn recommendation metadata into authority', () => {
    expect(decisionRoute).toMatch(/principalType === 'personal'/)
    expect(decisionRoute).toMatch(/resolvedBy !== 'unresolved'/)
    expect(decisionRoute).toMatch(/requireFounder/)
  })

  it('keeps the mission-control states compact and evidence expandable', () => {
    expect(surface).toMatch(/Working now/)
    expect(surface).toMatch(/Needs your judgment/)
    expect(surface).toMatch(/Worth considering/)
    expect(surface).toMatch(/Watching quietly/)
    expect(card).toMatch(/ACTING ON RECOMMENDATION/)
    expect(card).toMatch(/DECISION · APPROVED/)
    expect(card).toMatch(/RECOMMENDATION UPDATED/)
    expect(card).toMatch(/<details/)
  })

  it('requires explicit execution and granted authority before calling a recommendation active work', () => {
    expect(surface).toMatch(/executionState/)
    expect(surface).toMatch(/authorityDisposition/)
    expect(surface).toMatch(/in_progress/)
    expect(surface).toMatch(/within_authority/)
  })
})
