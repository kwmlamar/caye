import { describe, expect, it } from 'vitest'
import {
  deriveEffectRetryDecision,
  deriveEffectVerification,
  type EffectObservation,
  type ExecutionReceipt,
} from './effect-verification'

const workspaceId = 'workspace-a'
const effect = 'booking_update'
const expected = { booking_date: '2026-09-01', booking_time: '10:00:00', status: 'confirmed' }
const execution = (over: Partial<ExecutionReceipt> = {}): ExecutionReceipt => ({
  ok: true,
  attemptedAt: '2026-08-30T16:00:00.000Z',
  executedAt: '2026-08-30T16:00:01.000Z',
  externalId: 'booking-1',
  ...over,
})
const observation = (state: Record<string, unknown>, over: Partial<EffectObservation> = {}): EffectObservation => ({
  workspaceId,
  effect,
  observedAt: '2026-08-30T16:00:02.000Z',
  source: 'authoritative_readback',
  state,
  ...over,
})

describe('deriveEffectVerification', () => {
  it('never verifies an executor failure', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution({ ok: false, executedAt: null, error: 'provider rejected write' }), observation: null })
    expect(result.status).toBe('FAILED')
  })

  it('provider says success but read-back missing', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution({ httpStatus: 200 }), observation: null })
    expect(result.status).toBe('INDETERMINATE')
  })

  it('timeout after possible success is indeterminate', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution({ ok: true, executedAt: null, error: 'timeout after request body sent' }), observation: null })
    expect(result.status).toBe('INDETERMINATE')
  })

  it('partial mutation remains PARTIAL', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation({ booking_date: '2026-09-01', booking_time: '09:00:00' }) })
    expect(result.status).toBe('PARTIAL')
  })

  it('stale observation cannot verify', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation(expected, { observedAt: '2026-08-30T15:59:59.000Z' }) })
    expect(result.status).toBe('INDETERMINATE')
  })

  it('wrong workspace is FAILED', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation(expected, { workspaceId: 'workspace-b' }) })
    expect(result.status).toBe('FAILED')
  })

  it('provider unavailable leaves result INDETERMINATE', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation({}, { state: null, error: 'provider unavailable' }) })
    expect(result.status).toBe('INDETERMINATE')
  })

  it('eventual consistency can move from INDETERMINATE to VERIFIED only after later read-back', () => {
    const first = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation({ absent: true }) })
    const later = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation(expected, { observedAt: '2026-08-30T16:00:08.000Z' }) })
    expect(first.status).not.toBe('VERIFIED')
    expect(later.status).toBe('VERIFIED')
  })

  it('conflicting read-back cannot verify', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation({ booking_date: '2026-09-02', booking_time: '11:00:00', status: 'cancelled' }) })
    expect(result.status).toBe('FAILED')
  })

  it('VERIFIED requires qualifying independent evidence', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: observation(expected) })
    expect(result.status).toBe('VERIFIED')
    expect(result.comparisons.every(c => c.matches)).toBe(true)
  })
})

describe('deriveEffectRetryDecision', () => {
  it('blocks duplicate create after indeterminate result', () => {
    const decision = deriveEffectRetryDecision({ status: 'INDETERMINATE', actionKind: 'create', providerFailureRetryable: true })
    expect(decision.retryMutation).toBe(false)
    expect(decision.recovery).toBe('observe_only')
  })

  it('blocks retry after partial mutation', () => {
    const decision = deriveEffectRetryDecision({ status: 'PARTIAL', actionKind: 'update', providerFailureRetryable: true })
    expect(decision.retryMutation).toBe(false)
    expect(decision.recovery).toBe('manual_review')
  })

  it('permits retry only for a definitive retryable FAILED execution', () => {
    const safe = deriveEffectRetryDecision({ status: 'FAILED', actionKind: 'create', providerFailureRetryable: true })
    const unsafe = deriveEffectRetryDecision({ status: 'FAILED', actionKind: 'create', providerFailureRetryable: false })
    expect(safe.retryMutation).toBe(true)
    expect(unsafe.retryMutation).toBe(false)
  })
})
