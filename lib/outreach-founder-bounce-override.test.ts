import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))

type MockResult = { data: unknown; error: unknown; count?: number }
function makeDb(queues: Record<string, MockResult[]>) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = []
  function chain(table: string) {
    const resolve = (): Promise<MockResult> => Promise.resolve(queues[table]?.shift() ?? { data: null, error: null })
    const builder: Record<string, (...args: unknown[]) => unknown> & PromiseLike<MockResult> = {
      select: (...args: unknown[]) => { calls.push({ table, op: 'select', args }); return builder },
      update: (...args: unknown[]) => { calls.push({ table, op: 'update', args }); return builder },
      insert: (...args: unknown[]) => { calls.push({ table, op: 'insert', args }); return resolve() },
      eq: (...args: unknown[]) => { calls.push({ table, op: 'eq', args }); return builder },
      gte: (...args: unknown[]) => { calls.push({ table, op: 'gte', args }); return builder },
      maybeSingle: () => { calls.push({ table, op: 'maybeSingle', args: [] }); return resolve() },
      then: (onfulfilled: (value: MockResult) => unknown) => resolve().then(onfulfilled),
    } as never
    return builder
  }
  return { db: { from: (table: string) => chain(table) }, calls }
}

vi.mock('./supabase-server', () => ({ createServiceClient: vi.fn() }))
const { createServiceClient } = await import('./supabase-server')
const { founderOverrideResolvedBounceSafetyPause } = await import('./outreach-pause-control')

beforeEach(() => vi.clearAllMocks())

describe('founderOverrideResolvedBounceSafetyPause', () => {
  it('rejects empty justification before any database work', async () => {
    await expect(founderOverrideResolvedBounceSafetyPause('ws-a', '   ')).rejects.toThrow(/justification/i)
  })

  it.each([null, 'provider_safety', 'compliance', 'owner_manual'])('does not clear non-bounce source %s', async (source) => {
    const seeded = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: true, outreach_pause_source: source, outreach_pause_reason: 'r', outreach_paused_at: 't', outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)
    const result = await founderOverrideResolvedBounceSafetyPause('ws-a', 'reviewed')
    expect(result.disposition).not.toBe('running')
    expect(seeded.calls.some((call) => call.op === 'update')).toBe(false)
  })

  it('refuses while the live bounce threshold is still active', async () => {
    const seeded = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: true, outreach_pause_source: 'bounce_safety', outreach_pause_reason: 'r', outreach_paused_at: 't', outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null }],
      caye_outreach_bounces: [{ data: null, error: null, count: 5 }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)
    const result = await founderOverrideResolvedBounceSafetyPause('ws-a', 'reviewed')
    expect(result.disposition).toBe('safety_active')
    expect(seeded.calls.some((call) => call.op === 'update')).toBe(false)
  })

  it('clears and audits a resolved bounce_safety stop', async () => {
    const seeded = makeDb({
      workspace_ai_config: [
        { data: { outreach_autosend_paused: true, outreach_pause_source: 'bounce_safety', outreach_pause_reason: 'r', outreach_paused_at: 't', outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null },
        { data: [{ workspace_id: 'ws-a' }], error: null },
      ],
      caye_outreach_bounces: [{ data: null, error: null, count: 0 }],
      caye_outreach_pause_events: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)
    const result = await founderOverrideResolvedBounceSafetyPause('ws-a', 'Reviewed bounce condition')
    expect(result.disposition).toBe('running')
    const audit = seeded.calls.find((call) => call.table === 'caye_outreach_pause_events' && call.op === 'insert')
    expect(audit?.args[0]).toMatchObject({ workspace_id: 'ws-a', action: 'resumed', source: 'bounce_safety', actor_role: 'founder' })
    expect(JSON.stringify(audit?.args[0])).toContain('Reviewed bounce condition')
  })
})
