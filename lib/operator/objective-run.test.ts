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
})
