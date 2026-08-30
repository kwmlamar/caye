import { describe, expect, it, vi } from 'vitest'
import { runBoundedObjective } from './objective-run'

describe('interrupted objective recovery', () => {
  it('fails closed when a process died after an effect started and retry safety is unknown', async () => {
    const execute = vi.fn(async () => ({ duplicated: true }))
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['write_low'] as const),
      interruptedSteps: new Set(['mutate']),
      steps: [{
        key: 'mutate',
        authority: 'write_low',
        execute,
        verify: async () => ({ ok: true }),
      }],
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedStep).toBe('mutate')
    expect(execute).not.toHaveBeenCalled()
    expect(result.events.at(-1)).toMatchObject({ state: 'blocked' })
  })

  it('retries an interrupted effect only after workflow-specific reconciliation declares it safe', async () => {
    const execute = vi.fn(async () => ({ effectId: 'safe-retry' }))
    const recoverInterrupted = vi.fn(async () => ({
      status: 'retry_safe' as const,
      reason: 'idempotency key/state check proves retry safe',
      evidence: { checked: true },
    }))
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['write_low'] as const),
      interruptedSteps: new Set(['mutate']),
      steps: [{
        key: 'mutate',
        authority: 'write_low',
        recoverInterrupted,
        execute,
        verify: async (_ctx, effect) => ({ ok: true, evidence: effect }),
      }],
    })

    expect(result.status).toBe('completed')
    expect(recoverInterrupted).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.events).toContainEqual(expect.objectContaining({
      state: 'checking',
      evidence: expect.objectContaining({ mode: 'interrupted_retry_declared_safe' }),
    }))
  })

  it('waits rather than replaying when interrupted reconciliation is still indeterminate', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['write_low'] as const),
      interruptedSteps: new Set(['mutate']),
      steps: [{
        key: 'mutate',
        authority: 'write_low',
        recoverInterrupted: async () => ({ status: 'wait', reason: 'original worker effect still running', resumeAfterMs: 5_000 }),
        execute,
        verify: async () => ({ ok: true }),
      }],
    })

    expect(result.status).toBe('waiting')
    expect(result.resumeAt).toBeTruthy()
    expect(execute).not.toHaveBeenCalled()
  })
})
