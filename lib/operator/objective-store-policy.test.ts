import { describe, expect, it } from 'vitest'
import { evaluateDurableRunCompatibility } from './objective-store'

describe('evaluateDurableRunCompatibility', () => {
  it('retires an old deployed plan before any verified steps can be reused', () => {
    const result = evaluateDurableRunCompatibility({
      storedPlanVersion: '1',
      requestedPlanVersion: '2',
      deadlineAt: null,
      nowMs: Date.parse('2026-08-30T20:00:00Z'),
    })

    expect(result).toMatchObject({
      status: 'blocked',
      blockedStep: '__plan_version__',
    })
    expect(result?.error).toContain('old verified steps were not reused')
  })

  it('retires a matching plan when its durable deadline has expired', () => {
    const result = evaluateDurableRunCompatibility({
      storedPlanVersion: '2',
      requestedPlanVersion: '2',
      deadlineAt: '2026-08-30T19:59:59Z',
      nowMs: Date.parse('2026-08-30T20:00:00Z'),
    })

    expect(result).toEqual({
      status: 'failed',
      blockedStep: '__durable_deadline__',
      error: 'Objective exceeded its durable wall-clock deadline and was not resumed.',
    })
  })

  it('keeps a compatible unexpired run resumable', () => {
    const result = evaluateDurableRunCompatibility({
      storedPlanVersion: '2',
      requestedPlanVersion: '2',
      deadlineAt: '2026-08-30T20:15:00Z',
      nowMs: Date.parse('2026-08-30T20:00:00Z'),
    })

    expect(result).toBeNull()
  })
})
