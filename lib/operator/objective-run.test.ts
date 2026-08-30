import { describe, expect, it, vi } from 'vitest'
import { runBoundedObjective } from './objective-run'

describe('runBoundedObjective', () => {
  it('executes only granted authority and records verified evidence', async () => {
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['read', 'write_low'] as const),
      steps: [{
        key: 'inspect', authority: 'read',
        execute: async () => ({ inspected: 3 }),
        verify: async (_ctx, effect) => ({ ok: true, evidence: effect }),
      }],
    })
    expect(result.status).toBe('completed')
    expect(result.completedSteps).toEqual(['inspect'])
    expect(result.transitionsUsed).toBe(1)
    expect(result.events.at(-1)).toMatchObject({ state: 'verified', evidence: { inspected: 3 } })
  })

  it('blocks before executing an unauthorized step', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['read'] as const),
      steps: [{ key: 'submit', authority: 'write_high', execute, verify: async () => ({ ok: true }) }],
    })
    expect(result.status).toBe('blocked')
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not call an attempted effect successful when verification fails', async () => {
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['read'] as const),
      steps: [{ key: 'inspect', authority: 'read', maxAttempts: 2, execute: async () => ({ attempted: true }), verify: async () => ({ ok: false, reason: 'not observed' }) }],
    })
    expect(result.status).toBe('failed')
    expect(result.completedSteps).toEqual([])
    expect(result.events.filter((event) => event.state === 'failed')).toHaveLength(2)
  })

  it('resumes after already verified steps without replaying their side effects', async () => {
    const prepare = vi.fn()
    const inspect = vi.fn(async () => ({ inspected: 2 }))
    const onEvent = vi.fn(async () => undefined)
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['read', 'write_low'] as const),
      completedSteps: new Set(['prepare']),
      onEvent,
      steps: [
        { key: 'prepare', authority: 'write_low', execute: prepare, verify: async () => ({ ok: true }) },
        { key: 'inspect', authority: 'read', execute: inspect, verify: async (_ctx, effect) => ({ ok: true, evidence: effect }) },
      ],
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(result.completedSteps).toEqual(['prepare', 'inspect'])
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ step: 'inspect', state: 'verified' }))
  })

  it('does not reset the durable transition budget when a run resumes', async () => {
    const execute = vi.fn(async () => ({ attempted: true }))
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['read'] as const),
      transitionsAlreadyUsed: 3,
      maxTransitions: 3,
      steps: [{ key: 'inspect', authority: 'read', execute, verify: async () => ({ ok: true }) }],
    })
    expect(result.status).toBe('budget_exhausted')
    expect(result.budgetReason).toBe('transitions')
    expect(result.transitionsUsed).toBe(3)
    expect(execute).not.toHaveBeenCalled()
  })

  it('distinguishes a slice timeout from durable transition exhaustion', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['read'] as const),
      timeoutMs: 0,
      maxTransitions: 3,
      steps: [{ key: 'inspect', authority: 'read', execute, verify: async () => ({ ok: true }) }],
    })
    expect(result.status).toBe('budget_exhausted')
    expect(result.budgetReason).toBe('timeout')
    expect(result.transitionsUsed).toBe(0)
    expect(execute).not.toHaveBeenCalled()
  })
})
