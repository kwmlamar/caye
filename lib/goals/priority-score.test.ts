import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { computePriorityScore, sortByPriorityScore } from './priority-score'
import type { GoalRow } from './types'

function goal(overrides: Partial<GoalRow>): GoalRow {
  return {
    id: 'g1', kind: 'goal', parentId: null, scope: 'workspace', workspaceId: 'ws-a',
    title: 'x', description: null, status: 'active', priority: 'medium',
    targetValue: null, currentValue: null, unit: null, targetDate: null, confidence: null,
    completionCriteria: null, activationConditions: null,
    createdByKind: 'founder', createdByLabel: null, createdByUserId: null, createdByOperatorId: null,
    source: null, rationale: null, supersededAt: null, supersededBy: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('computePriorityScore', () => {
  it('is a pure, deterministic function of the row — same input, same output', () => {
    const g = goal({ priority: 'high', targetDate: '2026-09-01', confidence: 0.8 })
    const now = new Date('2026-08-26T00:00:00Z')
    expect(computePriorityScore(g, now)).toEqual(computePriorityScore(g, now))
  })

  it('critical outranks high outranks medium outranks low, all else equal', () => {
    const now = new Date('2026-08-26T00:00:00Z')
    const scores = (['critical', 'high', 'medium', 'low'] as const).map(
      (priority) => computePriorityScore(goal({ priority }), now).score
    )
    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(scores[1]).toBeGreaterThan(scores[2])
    expect(scores[2]).toBeGreaterThan(scores[3])
  })

  it('a goal due sooner outranks an otherwise-identical goal due later', () => {
    const now = new Date('2026-08-26T00:00:00Z')
    const soon = computePriorityScore(goal({ priority: 'medium', targetDate: '2026-08-27' }), now).score
    const later = computePriorityScore(goal({ priority: 'medium', targetDate: '2027-06-01' }), now).score
    expect(soon).toBeGreaterThan(later)
  })

  it('a goal with no target date is not penalized relative to one with a far-off date', () => {
    const now = new Date('2026-08-26T00:00:00Z')
    const noDate = computePriorityScore(goal({ priority: 'medium', targetDate: null }), now).score
    const farDate = computePriorityScore(goal({ priority: 'medium', targetDate: '2028-01-01' }), now).score
    expect(noDate).toBeGreaterThanOrEqual(farDate)
  })

  it('missing confidence reads as neutral, not as zero/distrusted', () => {
    const now = new Date('2026-08-26T00:00:00Z')
    const unset = computePriorityScore(goal({ priority: 'medium', confidence: null }), now).score
    const lowConfidence = computePriorityScore(goal({ priority: 'medium', confidence: 0.1 }), now).score
    expect(unset).toBeGreaterThan(lowConfidence)
  })
})

describe('sortByPriorityScore', () => {
  it('orders goals highest score first without mutating the input array', () => {
    const now = new Date('2026-08-26T00:00:00Z')
    const low = goal({ id: 'a', priority: 'low' })
    const critical = goal({ id: 'b', priority: 'critical' })
    const medium = goal({ id: 'c', priority: 'medium' })
    const input = [low, critical, medium]
    const sorted = sortByPriorityScore(input, now)

    expect(sorted.map((g) => g.id)).toEqual(['b', 'c', 'a'])
    expect(input.map((g) => g.id)).toEqual(['a', 'b', 'c']) // unchanged
  })
})
