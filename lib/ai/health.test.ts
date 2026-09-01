import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('server-only', () => ({}))

let rows: Record<string, unknown>[] = []
const upserts: Record<string, unknown>[] = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: async () => ({ data: rows, error: null }),
      insert: async () => ({ error: null }),
      upsert: async (row: Record<string, unknown>) => {
        upserts.push(row)
        // Persist so a subsequent forced load sees what a second instance would.
        rows = [...rows.filter((r) => r.provider !== row.provider), row]
        return { error: null }
      },
    }),
  }),
}))

const {
  loadProviderHealth,
  isCircuitOpen,
  recordProviderFailure,
  recordProviderSuccess,
  clearProviderCircuit,
  resetHealthCache,
} = await import('./health')
const { setProviderAdapters } = await import('./providers')
const { FakeProvider } = await import('./test-support')

let restore: (() => void) | null = null

beforeEach(() => {
  rows = []
  upserts.length = 0
  resetHealthCache()
  restore = setProviderAdapters({
    anthropic: new FakeProvider('anthropic', { fingerprint: 'key-v1' }),
    openai: new FakeProvider('openai'),
    openrouter: new FakeProvider('openrouter'),
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  restore?.()
  vi.restoreAllMocks()
})

describe('circuit breaker', () => {
  it('opens immediately on billing exhaustion — that does not fix itself in 60s', async () => {
    await recordProviderFailure('anthropic', 'billing_exhausted', 'credit balance is too low')
    resetHealthCache()

    const health = (await loadProviderHealth(true)).get('anthropic')!

    expect(health.state).toBe('cooldown')
    expect(health.reason).toBe('billing_exhausted')
    expect(isCircuitOpen(health)).toBe(true)
  })

  it('requires repeated failures before opening on a transient 5xx', async () => {
    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    expect(isCircuitOpen((await loadProviderHealth(true)).get('anthropic'))).toBe(false)

    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    expect(isCircuitOpen((await loadProviderHealth(true)).get('anthropic'))).toBe(false)

    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    expect(isCircuitOpen((await loadProviderHealth(true)).get('anthropic'))).toBe(true)
  })

  it('does not count a malformed request against provider health', async () => {
    await recordProviderFailure('anthropic', 'malformed_request', 'bad messages')
    await recordProviderFailure('anthropic', 'malformed_request', 'bad messages')
    await recordProviderFailure('anthropic', 'malformed_request', 'bad messages')

    const health = (await loadProviderHealth(true)).get('anthropic')!
    expect(health.state).toBe('healthy')
    expect(health.consecutiveFailures).toBe(0)
  })

  it('becomes eligible again once the cooldown expires', async () => {
    await recordProviderFailure('anthropic', 'rate_limit', 'slow down')
    await recordProviderFailure('anthropic', 'rate_limit', 'slow down')
    await recordProviderFailure('anthropic', 'rate_limit', 'slow down')

    const health = (await loadProviderHealth(true)).get('anthropic')!
    expect(isCircuitOpen(health)).toBe(true)

    const afterCooldown = new Date(health.cooldownUntil!).getTime() + 1
    expect(isCircuitOpen(health, afterCooldown)).toBe(false)
  })

  it('resets failure state on a success', async () => {
    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    await recordProviderSuccess('anthropic')

    const health = (await loadProviderHealth(true)).get('anthropic')!
    expect(health.consecutiveFailures).toBe(0)
    expect(health.state).toBe('healthy')
    expect(health.lastSuccessAt).toBeTruthy()
  })

  it('releases a billing cooldown when the credential changes', async () => {
    await recordProviderFailure('anthropic', 'billing_exhausted', 'credit balance is too low')
    const health = (await loadProviderHealth(true)).get('anthropic')!
    expect(isCircuitOpen(health)).toBe(true)

    // Founder tops up / rotates the key and redeploys.
    restore?.()
    restore = setProviderAdapters({ anthropic: new FakeProvider('anthropic', { fingerprint: 'key-v2' }) })

    expect(isCircuitOpen(health)).toBe(false)
  })

  it('does not release a transient cooldown on a credential change', async () => {
    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    await recordProviderFailure('anthropic', 'upstream_5xx', 'boom')
    const health = (await loadProviderHealth(true)).get('anthropic')!

    restore?.()
    restore = setProviderAdapters({ anthropic: new FakeProvider('anthropic', { fingerprint: 'key-v2' }) })

    expect(isCircuitOpen(health)).toBe(true)
  })

  it('lets the founder force a provider back into rotation', async () => {
    await recordProviderFailure('anthropic', 'billing_exhausted', 'credit balance is too low')
    await clearProviderCircuit('anthropic')

    expect(isCircuitOpen((await loadProviderHealth(true)).get('anthropic'))).toBe(false)
  })

  it('shares state across instances via the persisted row', async () => {
    await recordProviderFailure('anthropic', 'billing_exhausted', 'credit balance is too low')

    // Simulate a cold second serverless instance: no in-process cache at all.
    resetHealthCache()
    const health = (await loadProviderHealth()).get('anthropic')!

    expect(isCircuitOpen(health)).toBe(true)
    expect(upserts.some((u) => u.provider === 'anthropic' && u.state === 'cooldown')).toBe(true)
  })
})
