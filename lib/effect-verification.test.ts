import { describe, expect, it } from 'vitest'
import { deriveEffectVerification, type EffectObservation, type ExecutionReceipt } from './effect-verification'

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
    const result = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution({ ok: false, executedAt: null, error: 'provider rejected write' }),
      observation: null,
    })
    expect(result.status).toBe('FAILED')
  })

  it('does not treat successful execution as verification without read-back', () => {
    const result = deriveEffectVerification({ workspaceId, effect, expected, execution: execution(), observation: null })
    expect(result.status).toBe('INDETERMINATE')
  })

  it('rejects HTTP/provider success when observed state disagrees', () => {
    const result = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution({ httpStatus: 200 }),
      observation: observation({ booking_date: '2026-09-01', booking_time: '09:00:00', status: 'pending' }),
    })
    expect(result.status).toBe('PARTIAL')
    expect(result.status).not.toBe('VERIFIED')
  })

  it('returns PARTIAL when only some expected fields are present', () => {
    const result = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution(),
      observation: observation({ booking_date: '2026-09-01', booking_time: '09:00:00' }),
    })
    expect(result.status).toBe('PARTIAL')
    expect(result.comparisons.some(c => c.missing)).toBe(true)
  })

  it('does not accept stale evidence', () => {
    const result = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution(),
      observation: observation(expected, { observedAt: '2026-08-30T15:59:59.000Z' }),
    })
    expect(result.status).toBe('INDETERMINATE')
  })

  it('does not verify malformed timestamps', () => {
    const badExecution = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution({ executedAt: 'definitely-not-a-date' }),
      observation: observation(expected),
    })
    const badObservation = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution(),
      observation: observation(expected, { observedAt: 'also-not-a-date' }),
    })
    expect(badExecution.status).toBe('INDETERMINATE')
    expect(badObservation.status).toBe('INDETERMINATE')
  })

  it('rejects cross-workspace evidence', () => {
    const result = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution(),
      observation: observation(expected, { workspaceId: 'workspace-b' }),
    })
    expect(result.status).toBe('FAILED')
  })

  it('rejects evidence for another capability/effect', () => {
    const result = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution(),
      observation: observation(expected, { effect: 'email_send' }),
    })
    expect(result.status).toBe('FAILED')
  })

  it('derives VERIFIED only from successful execution plus qualifying independent evidence', () => {
    const result = deriveEffectVerification({
      workspaceId,
      effect,
      expected,
      execution: execution(),
      observation: observation(expected),
    })
    expect(result.status).toBe('VERIFIED')
    expect(result.comparisons.every(c => c.matches)).toBe(true)
  })
})
