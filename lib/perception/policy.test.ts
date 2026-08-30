import { describe, expect, it } from 'vitest'
import {
  classifyChange,
  decideInterruption,
  observationDedupeKey,
  retryDelaySeconds,
} from './policy'

describe('perception identity and change semantics', () => {
  it('scopes source event identity by workspace', () => {
    const common = { sourceKind: 'property.telemetry', sourceIdentity: 'ttn:app:sensor-1', sourceEventId: 'evt-42' }
    expect(observationDedupeKey({ workspaceId: 'workspace-a', ...common }))
      .not.toBe(observationDedupeKey({ workspaceId: 'workspace-b', ...common }))
  })

  it('is idempotent for the same workspace/source event identity', () => {
    const input = { workspaceId: 'workspace-a', sourceKind: 'property.telemetry', sourceIdentity: 'ttn:app:sensor-1', sourceEventId: 'evt-42' }
    expect(observationDedupeKey(input)).toBe(observationDedupeKey({ ...input }))
  })

  it('does not collide when identity components contain separators', () => {
    const left = observationDedupeKey({ workspaceId: 'workspace-a:b', sourceKind: 'c', sourceIdentity: 'd', sourceEventId: 'e' })
    const right = observationDedupeKey({ workspaceId: 'workspace-a', sourceKind: 'b:c', sourceIdentity: 'd', sourceEventId: 'e' })
    expect(left).not.toBe(right)
  })

  it('distinguishes initial, ordinary change, unchanged, and anomaly', () => {
    expect(classifyChange(null, 'a')).toBe('initial')
    expect(classifyChange('a', 'a')).toBe('unchanged')
    expect(classifyChange('a', 'b')).toBe('ordinary_change')
    expect(classifyChange('a', 'b', true)).toBe('anomaly')
  })
})

describe('perception failure and interruption policy', () => {
  it('backs retry off and caps it', () => {
    expect(retryDelaySeconds(1)).toBe(60)
    expect(retryDelaySeconds(2)).toBe(120)
    expect(retryDelaySeconds(6)).toBe(1920)
    expect(retryDelaySeconds(20)).toBe(3600)
  })

  it('does not interrupt on stale or low-confidence observations', () => {
    expect(decideInterruption({ severity: 'critical', anomaly: true, confidence: 1, fresh: false, sentInWindow: 0, maxInWindow: 3, minutesSinceEquivalentInterrupt: null, cooldownMinutes: 30 }))
      .toEqual({ interrupt: false, reason: 'stale' })
    expect(decideInterruption({ severity: 'critical', anomaly: true, confidence: 0.4, fresh: true, sentInWindow: 0, maxInWindow: 3, minutesSinceEquivalentInterrupt: null, cooldownMinutes: 30 }))
      .toEqual({ interrupt: false, reason: 'low_confidence' })
  })

  it('suppresses routine changes and budget-exhausted warnings', () => {
    expect(decideInterruption({ severity: 'notice', anomaly: false, confidence: 1, fresh: true, sentInWindow: 0, maxInWindow: 3, minutesSinceEquivalentInterrupt: null, cooldownMinutes: 30 }))
      .toEqual({ interrupt: false, reason: 'routine' })
    expect(decideInterruption({ severity: 'warning', anomaly: true, confidence: 1, fresh: true, sentInWindow: 3, maxInWindow: 3, minutesSinceEquivalentInterrupt: null, cooldownMinutes: 30 }))
      .toEqual({ interrupt: false, reason: 'budget_exhausted' })
  })

  it('lets critical alerts pierce count budget but not duplicate cooldown', () => {
    expect(decideInterruption({ severity: 'critical', anomaly: true, confidence: 1, fresh: true, sentInWindow: 99, maxInWindow: 3, minutesSinceEquivalentInterrupt: null, cooldownMinutes: 30 }))
      .toEqual({ interrupt: true, reason: 'critical' })
    expect(decideInterruption({ severity: 'critical', anomaly: true, confidence: 1, fresh: true, sentInWindow: 99, maxInWindow: 3, minutesSinceEquivalentInterrupt: 5, cooldownMinutes: 30 }))
      .toEqual({ interrupt: false, reason: 'cooldown' })
  })
})
