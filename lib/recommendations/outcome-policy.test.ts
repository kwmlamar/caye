import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aggregateKnownCalibration, classifyRecommendationOutcome } from './outcome-policy'

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901013500_recommendation_outcome_learning.sql'),
  'utf8'
)

describe('recommendation outcome learning', () => {
  it('marks accepted recommendation successful only from positive objective movement', () => {
    expect(classifyRecommendationOutcome('accepted', [
      { evidenceKind: 'execution_result', direction: 'positive', followed: true },
      { evidenceKind: 'goal_metric', direction: 'positive', measurable: true },
    ])).toMatchObject({ status: 'success', objectiveEffect: 'helped', wasFollowed: true })
  })

  it('marks accepted recommendation failed when objective movement is negative', () => {
    expect(classifyRecommendationOutcome('accepted', [
      { evidenceKind: 'execution_result', direction: 'positive', followed: true },
      { evidenceKind: 'system_metric', direction: 'negative', measurable: true },
    ])).toMatchObject({ status: 'failure', objectiveEffect: 'hurt', wasFollowed: true })
  })

  it('keeps a rejected recommendation outcome unknown without independent evidence', () => {
    expect(classifyRecommendationOutcome('rejected', [])).toEqual({
      status: 'unknown', objectiveEffect: 'unknown', wasFollowed: null,
      contradictedByLaterEvidence: false, evidenceConflict: false,
    })
  })

  it('records later contradiction without pretending it measured objective harm', () => {
    expect(classifyRecommendationOutcome('rejected', [
      { evidenceKind: 'research', direction: 'contradicts' },
    ])).toMatchObject({ status: 'failure', objectiveEffect: 'unknown', contradictedByLaterEvidence: true })
    expect(classifyRecommendationOutcome('accepted', [
      { evidenceKind: 'research', direction: 'supports' },
    ])).toMatchObject({ status: 'unknown', objectiveEffect: 'unknown' })
  })

  it('treats accepted execution with measured neutral impact as no measurable benefit', () => {
    expect(classifyRecommendationOutcome('accepted', [
      { evidenceKind: 'execution_result', direction: 'neutral', followed: true, measurable: true },
    ])).toMatchObject({ status: 'no_benefit', objectiveEffect: 'neutral', wasFollowed: true })
  })

  it('excludes unknown outcomes from calibration aggregates', () => {
    const aggregate = aggregateKnownCalibration([
      { confidence: 0.9, status: 'success' },
      { confidence: 0.9, status: 'failure' },
      { confidence: 0.9, status: 'unknown' },
    ])
    expect(aggregate.evaluatedCount).toBe(2)
    expect(aggregate.buckets[0]).toMatchObject({ evaluatedCount: 2, empiricalSuccessRate: 0.5 })
  })

  it('keeps founder feedback separate from objective evidence', () => {
    expect(migration).toMatch(/create table if not exists public\.caye_recommendation_founder_feedback/i)
    expect(migration).toMatch(/evidence_kind text not null check \(evidence_kind in \('system_metric','goal_metric','execution_result','intelligence','research'\)\)/i)
    expect(migration).not.toMatch(/evidence_kind[^\n]+founder_feedback/i)
  })

  it('pins evaluations to canonical recommendation decisions and fails cross-workspace', () => {
    expect(migration).toMatch(/decision_id uuid not null references public\.caye_recommendation_decisions\(id\)/i)
    expect(migration).toMatch(/v_decision\.recommendation_id is distinct from v_rec\.id/i)
    expect(migration).toMatch(/v_rec\.workspace_id is distinct from p_workspace_id/i)
    expect(migration).toMatch(/recommendation outcome decision workspace mismatch/i)
  })

  it('makes duplicate evaluation idempotent and rejects model self-grading', () => {
    expect(migration).toMatch(/caye-recommendation-outcome-v2/i)
    expect(migration).toMatch(/on conflict \(fingerprint\) do update/i)
    expect(migration).toMatch(/model self-evaluation is not outcome evidence/i)
    expect(migration).toMatch(/model-generated evidence cannot grade recommendations/i)
  })

  it('exposes requested deterministic calibration signals without changing authority', () => {
    expect(migration).toMatch(/'falsePositiveRate'/)
    expect(migration).toMatch(/'acceptedNoBenefitRate'/)
    expect(migration).toMatch(/'contradictedRate'/)
    expect(migration).toMatch(/'ignoredOrRejectedRate'/)
    expect(migration).toMatch(/'confidenceBuckets'/)
    expect(migration).toMatch(/'generationContext'/)
    expect(migration).not.toMatch(/update public\.operator_allowlist|update public\.operator_authority_delegations/i)
  })
})
