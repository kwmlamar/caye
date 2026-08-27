import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface FakeMetric {
  id: number
  goalId: string
  metricKey: string
  value: number
  unit: string | null
  evidenceKind: 'authoritative' | 'estimated'
  source: string
  evidenceRef: string | null
  recordedBy: string | null
  note: string | null
  observedAt: string
  createdAt: string
}

let metricsByGoal: Record<string, FakeMetric[]> = {}

vi.mock('./goals', () => ({
  listMetrics: async (goalId: string) => metricsByGoal[goalId] ?? [],
}))

const { evaluateActivationEligibility } = await import('./eligibility')
import type { GoalRow } from './types'

function goal(overrides: Partial<GoalRow>): GoalRow {
  return {
    id: 'g1', kind: 'objective', parentId: null, scope: 'operator', workspaceId: null,
    title: 'Robotics', description: null, status: 'future', priority: 'low',
    targetValue: null, currentValue: null, unit: null, targetDate: null, confidence: null,
    completionCriteria: null, activationConditions: null,
    createdByKind: 'founder', createdByLabel: null, createdByUserId: null, createdByOperatorId: null,
    source: null, rationale: null, supersededAt: null, supersededBy: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function metric(goalId: string, key: string, value: number, observedAt: string): FakeMetric {
  return {
    id: Math.random(), goalId, metricKey: key, value, unit: null, evidenceKind: 'authoritative',
    source: 'test', evidenceRef: null, recordedBy: null, note: null, observedAt, createdAt: observedAt,
  }
}

beforeEach(() => {
  metricsByGoal = {}
})

describe('evaluateActivationEligibility', () => {
  it('a goal with no activation_conditions is never eligible (nothing to evaluate)', async () => {
    const g = goal({ activationConditions: null })
    const result = await evaluateActivationEligibility(g)
    expect(result.hasConditions).toBe(false)
    expect(result.eligible).toBe(false)
  })

  it('reports not-eligible when a required metric has never been recorded', async () => {
    const g = goal({ activationConditions: [{ metric_key: 'caye_mrr_usd', comparator: '>=', threshold: 20000 }] })
    const result = await evaluateActivationEligibility(g)
    expect(result.eligible).toBe(false)
    expect(result.conditions[0].latestValue).toBeNull()
  })

  it('is eligible when every condition is met by the latest metric', async () => {
    const g = goal({
      id: 'robotics',
      activationConditions: [
        { metric_key: 'caye_mrr_usd', comparator: '>=', threshold: 20000 },
        { metric_key: 'operator_intervention_rate', comparator: '<=', threshold: 0.10 },
      ],
    })
    metricsByGoal.robotics = [
      metric('robotics', 'caye_mrr_usd', 25000, '2026-08-01T00:00:00Z'),
      metric('robotics', 'operator_intervention_rate', 0.08, '2026-08-01T00:00:00Z'),
    ]
    const result = await evaluateActivationEligibility(g)
    expect(result.eligible).toBe(true)
    expect(result.conditions.every((c) => c.met)).toBe(true)
  })

  it('is not eligible when only some conditions are met', async () => {
    const g = goal({
      id: 'robotics',
      activationConditions: [
        { metric_key: 'caye_mrr_usd', comparator: '>=', threshold: 20000 },
        { metric_key: 'operator_intervention_rate', comparator: '<=', threshold: 0.10 },
      ],
    })
    metricsByGoal.robotics = [
      metric('robotics', 'caye_mrr_usd', 25000, '2026-08-01T00:00:00Z'),
      metric('robotics', 'operator_intervention_rate', 0.30, '2026-08-01T00:00:00Z'),
    ]
    const result = await evaluateActivationEligibility(g)
    expect(result.eligible).toBe(false)
  })

  it('uses the most recent observation when multiple metric rows exist for the same key', async () => {
    const g = goal({
      id: 'robotics',
      activationConditions: [{ metric_key: 'caye_mrr_usd', comparator: '>=', threshold: 20000 }],
    })
    // listMetrics is documented to return newest-first; this stub matches that contract.
    metricsByGoal.robotics = [
      metric('robotics', 'caye_mrr_usd', 5000, '2026-08-20T00:00:00Z'), // newest, stale/low
      metric('robotics', 'caye_mrr_usd', 25000, '2026-01-01T00:00:00Z'), // older, high
    ]
    const result = await evaluateActivationEligibility(g)
    expect(result.conditions[0].latestValue).toBe(5000)
    expect(result.eligible).toBe(false)
  })

  it('an operator_approval-style condition is never satisfied by another metric — it requires its own row', async () => {
    const g = goal({
      id: 'robotics',
      activationConditions: [
        { metric_key: 'caye_mrr_usd', comparator: '>=', threshold: 20000 },
        { metric_key: 'operator_approval', comparator: '==', threshold: 1, note: 'requires explicit founder approval' },
      ],
    })
    metricsByGoal.robotics = [metric('robotics', 'caye_mrr_usd', 25000, '2026-08-01T00:00:00Z')]
    const result = await evaluateActivationEligibility(g)
    expect(result.eligible).toBe(false)
    const approvalCondition = result.conditions.find((c) => c.condition.metric_key === 'operator_approval')
    expect(approvalCondition?.met).toBe(false)
  })
})
