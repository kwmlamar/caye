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

  it('blocks before executing an unauthorized approval-requiring step', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['read'] as const),
      steps: [{ key: 'submit', authority: 'write_high', execute, verify: async () => ({ ok: true }) }],
    })
    expect(result.status).toBe('blocked')
    expect(result.blockedStep).toBe('submit')
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

  it('reports a tool failure honestly after bounded retries', async () => {
    const execute = vi.fn(async () => { throw new Error('tool offline') })
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['read'] as const),
      steps: [{ key: 'inspect', authority: 'read', maxAttempts: 2, execute, verify: async () => ({ ok: true }) }],
    })
    expect(result.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(result.events.at(-1)).toMatchObject({ state: 'failed', error: 'tool offline' })
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

  it('re-evaluates changed reality, revises the plan with lineage, and never replays a verified effect', async () => {
    const prepare = vi.fn(async () => ({ prepared: true }))
    const inspect = vi.fn(async () => ({ inspected: true }))
    let reality = 'old'
    const replan = vi.fn(async ({ context, nextRevision }) => {
      context.baseline = reality
      return { context, evidence: { accepted: reality, nextRevision } }
    })
    const context = { baseline: 'old' }

    const result = await runBoundedObjective({
      context,
      allowedAuthority: new Set(['read', 'write_low'] as const),
      maxPlanRevisions: 2,
      onReplan: replan,
      steps: [
        {
          key: 'prepare', authority: 'write_low',
          execute: prepare,
          verify: async () => {
            reality = 'new'
            return { ok: true }
          },
        },
        {
          key: 'inspect', authority: 'read',
          checkState: async (ctx) => ctx.baseline === reality
            ? { status: 'current' as const }
            : { status: 'changed' as const, reason: 'queue changed', evidence: { reality } },
          execute: inspect,
          verify: async () => ({ ok: true }),
        },
      ],
    })

    expect(result.status).toBe('completed')
    expect(result.planRevision).toBe(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(replan).toHaveBeenCalledTimes(1)
    expect(result.events).toContainEqual(expect.objectContaining({
      step: 'inspect',
      state: 'replanned',
      evidence: expect.objectContaining({ previousRevision: 0, planRevision: 1, reason: 'queue changed' }),
    }))
  })

  it('stops when the bounded plan revision budget is exhausted', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['read'] as const),
      planRevision: 2,
      maxPlanRevisions: 2,
      onReplan: async () => ({}),
      steps: [{
        key: 'inspect', authority: 'read',
        checkState: async () => ({ status: 'changed', reason: 'still changing' }),
        execute,
        verify: async () => ({ ok: true }),
      }],
    })
    expect(result.status).toBe('budget_exhausted')
    expect(result.budgetReason).toBe('revisions')
    expect(execute).not.toHaveBeenCalled()
  })

  it('durably waits when fresh state is unavailable instead of executing a stale plan', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['read'] as const),
      steps: [{
        key: 'inspect', authority: 'read',
        checkState: async () => ({ status: 'wait', reason: 'source unavailable', resumeAfterMs: 5_000 }),
        execute,
        verify: async () => ({ ok: true }),
      }],
    })
    expect(result.status).toBe('waiting')
    expect(result.resumeAt).toBeTruthy()
    expect(execute).not.toHaveBeenCalled()
    expect(result.events.at(-1)).toMatchObject({ state: 'waiting' })
  })

  it('survives a process boundary after an indeterminate verification without replaying the effect', async () => {
    const execute = vi.fn(async () => ({ effectId: 'effect-1' }))
    const first = await runBoundedObjective({
      context: {}, allowedAuthority: new Set(['write_low'] as const),
      steps: [{
        key: 'mutate', authority: 'write_low', execute,
        verify: async () => ({ ok: false, indeterminate: true, reason: 'read-after-write unavailable' }),
      }],
    })
    expect(first.status).toBe('waiting')
    const wait = first.events.find((event) => event.state === 'waiting')
    expect(wait?.evidence).toMatchObject({ pendingEffect: { effectId: 'effect-1' } })

    const resumed = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['write_low'] as const),
      pendingEffects: new Map([['mutate', { effectId: 'effect-1' }]]),
      transitionsAlreadyUsed: first.transitionsUsed,
      steps: [{
        key: 'mutate', authority: 'write_low', execute,
        verify: async (_ctx, effect) => ({ ok: true, evidence: { reconciled: effect } }),
      }],
    })
    expect(resumed.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(resumed.events.at(-1)).toMatchObject({ state: 'verified', attempt: 0 })
  })

  it('blocks rather than replaying a pending effect when reconciliation definitively fails', async () => {
    const execute = vi.fn()
    const result = await runBoundedObjective({
      context: {},
      allowedAuthority: new Set(['write_low'] as const),
      pendingEffects: new Map([['mutate', { effectId: 'old' }]]),
      steps: [{
        key: 'mutate', authority: 'write_low', execute,
        verify: async () => ({ ok: false, reason: 'effect absent and retry safety unknown' }),
      }],
    })
    expect(result.status).toBe('blocked')
    expect(execute).not.toHaveBeenCalled()
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
