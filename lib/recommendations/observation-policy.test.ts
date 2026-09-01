import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyRecommendationOutcome } from './outcome-policy'
import {
  classifyMeasurableOutcome,
  isEvidenceSufficient,
  isObservationDue,
  isObservationExpired,
  isOutcomeStillUnknown,
  observationStateAfterAttempt,
  type RecommendationObservationWindow,
} from './observation-policy'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901021500_recommendation_outcome_observations.sql'),
  'utf8'
)

const pending = (overrides: Partial<RecommendationObservationWindow> = {}): RecommendationObservationWindow => ({
  state: 'pending',
  nextObservationAt: '2026-09-02T00:00:00.000Z',
  expiresAt: '2026-09-03T00:00:00.000Z',
  observationCount: 0,
  maxObservations: 3,
  ...overrides,
})

describe('recommendation outcome observation', () => {
  it('execution success alone is not recommendation success', () => {
    const evidence = [{ evidenceKind: 'execution_result' as const, direction: 'unknown' as const, followed: true, measurable: false }]
    expect(classifyRecommendationOutcome('accepted', evidence)).toMatchObject({
      status: 'unknown', objectiveEffect: 'unknown', wasFollowed: true,
    })
    expect(isEvidenceSufficient(evidence)).toBe(false)
  })

  it('measurable positive result feeds #372 as success', () => {
    const evidence = [
      { evidenceKind: 'execution_result' as const, direction: 'unknown' as const, followed: true },
      { evidenceKind: 'goal_metric' as const, direction: 'positive' as const, measurable: true },
    ]
    expect(classifyMeasurableOutcome(evidence)).toBe('positive')
    expect(classifyRecommendationOutcome('accepted', evidence).status).toBe('success')
  })

  it('measurable negative result feeds #372 as failure', () => {
    const evidence = [{ evidenceKind: 'system_metric' as const, direction: 'negative' as const, measurable: true }]
    expect(classifyMeasurableOutcome(evidence)).toBe('negative')
    expect(classifyRecommendationOutcome('accepted', evidence).status).toBe('failure')
  })

  it('neutral measurable evidence means no benefit', () => {
    const evidence = [{ evidenceKind: 'system_metric' as const, direction: 'neutral' as const, measurable: true }]
    expect(classifyMeasurableOutcome(evidence)).toBe('no_benefit')
    expect(classifyRecommendationOutcome('accepted', evidence).status).toBe('no_benefit')
  })

  it('no measurable evidence remains unknown', () => {
    const evidence = [{ evidenceKind: 'research' as const, direction: 'supports' as const }]
    expect(isOutcomeStillUnknown(evidence)).toBe(true)
    expect(isEvidenceSufficient(evidence)).toBe(false)
  })

  it('observation is due only inside its bounded pending window', () => {
    expect(isObservationDue(pending(), new Date('2026-09-02T00:00:01.000Z'))).toBe(true)
    expect(isObservationDue(pending(), new Date('2026-09-01T23:59:59.000Z'))).toBe(false)
    expect(isObservationDue(pending({ state: 'satisfied' }), new Date('2026-09-02T00:00:01.000Z'))).toBe(false)
  })

  it('bounded observation terminates on horizon or attempt budget', () => {
    expect(isObservationExpired(pending(), new Date('2026-09-03T00:00:00.000Z'))).toBe(true)
    expect(isObservationExpired(pending({ observationCount: 3 }), new Date('2026-09-02T00:00:00.000Z'))).toBe(true)
    expect(observationStateAfterAttempt({
      observation: pending({ observationCount: 2 }), evidence: [], now: new Date('2026-09-02T00:00:00.000Z'),
    })).toBe('expired')
  })

  it('duplicate observation registration is idempotent', () => {
    expect(migration).toMatch(/caye-recommendation-observation-v1/i)
    expect(migration).toMatch(/fingerprint text not null unique/i)
    expect(migration).toMatch(/on conflict \(fingerprint\) do nothing/i)
  })

  it('later contradictory evidence can alter the latest evaluation', () => {
    const positive = [{ evidenceKind: 'goal_metric' as const, direction: 'positive' as const, measurable: true }]
    expect(classifyRecommendationOutcome('accepted', positive).status).toBe('success')

    const later = [...positive, { evidenceKind: 'intelligence' as const, direction: 'contradicts' as const }]
    expect(classifyRecommendationOutcome('accepted', later)).toMatchObject({
      status: 'success', contradictedByLaterEvidence: true,
    })

    const conflicting = [...later, { evidenceKind: 'goal_metric' as const, direction: 'negative' as const, measurable: true }]
    expect(classifyRecommendationOutcome('accepted', conflicting)).toMatchObject({
      status: 'unknown', evidenceConflict: true, contradictedByLaterEvidence: true,
    })
  })

  it('founder praise cannot masquerade as objective metric evidence', () => {
    expect(migration).not.toMatch(/founder_feedback|usefulness|not_useful/i)
    expect(migration).not.toMatch(/update public\.operator_allowlist|update public\.operator_authority_delegations/i)
  })

  it('persists only bounded observation scheduling, never executable queries or destinations', () => {
    expect(migration).toMatch(/cadence_seconds integer not null check \(cadence_seconds between 60 and 604800\)/i)
    expect(migration).toMatch(/max_observations integer not null check \(max_observations between 1 and 32\)/i)
    expect(migration).toMatch(/expires_at <= registered_at \+ interval '30 days'/i)
    expect(migration).not.toMatch(/\bsql\b.*text|\burl\b.*text|\bcommand\b.*text/i)
  })
})
