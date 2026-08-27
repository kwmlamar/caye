import { describe, expect, it, vi, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))

// Minimal fluent fake mirroring the subset of the supabase-js query builder
// this module actually calls: from().select().eq().maybeSingle(),
// from().select().eq() awaited directly (no maybeSingle), and
// from().update().eq().eq().is().select() awaited directly. Each table has
// its own response queue, consumed in call order — deterministic because
// every code path under test calls each table's terminal method a fixed
// number of times in a fixed order.
type MockResult = { data: unknown; error: unknown }
function makeDb(queues: Record<string, MockResult[]>) {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = []
  function chain(table: string) {
    const resolve = (): Promise<MockResult> => {
      const q = queues[table]
      return Promise.resolve(q?.shift() ?? { data: null, error: null })
    }
    const builder: Record<string, (...args: unknown[]) => unknown> & PromiseLike<MockResult> = {
      select: (...args: unknown[]) => { calls.push({ table, op: 'select', args }); return builder },
      update: (...args: unknown[]) => { calls.push({ table, op: 'update', args }); return builder },
      insert: (...args: unknown[]) => { calls.push({ table, op: 'insert', args }); return resolve() },
      eq: (...args: unknown[]) => { calls.push({ table, op: 'eq', args }); return builder },
      is: (...args: unknown[]) => { calls.push({ table, op: 'is', args }); return builder },
      maybeSingle: () => { calls.push({ table, op: 'maybeSingle', args: [] }); return resolve() },
      then: (onfulfilled: (value: MockResult) => unknown) => resolve().then(onfulfilled),
    } as never
    return builder
  }
  return { db: { from: (table: string) => chain(table) }, calls }
}

vi.mock('./supabase-server', () => ({ createServiceClient: vi.fn() }))
const { createServiceClient } = await import('./supabase-server')
const {
  classifyOutreachPause,
  findTrailingWindowCrossing,
  reconcileLegacyOutreachPause,
  resumeOwnerPausedOutreach,
} = await import('./outreach-pause-control')

beforeEach(() => vi.clearAllMocks())

describe('outreach pause provenance', () => {
  it('allows an owner-created pause to be recovered', () => {
    expect(classifyOutreachPause({ paused: true, source: 'owner_manual' }).disposition).toBe('owner_resumable')
  })

  it('never lets owner recovery override the bounce safety stop', () => {
    expect(classifyOutreachPause({ paused: true, source: 'bounce_safety', activeSafetyCondition: 'bounce_threshold' }).disposition).toBe('safety_active')
  })

  it('does not turn a historical safety stop into an owner override after the immediate threshold clears', () => {
    expect(classifyOutreachPause({ paused: true, source: 'bounce_safety' }).disposition).toBe('safety_recovery_not_supported')
  })

  it('keeps legacy pauses blocked when their source is not provable', () => {
    expect(classifyOutreachPause({ paused: true }).disposition).toBe('unknown_blocked')
  })
})

describe('findTrailingWindowCrossing', () => {
  it('finds no crossing below the threshold', () => {
    const times = ['2026-08-23T11:02:07Z', '2026-08-23T21:56:07Z']
    expect(findTrailingWindowCrossing(times, 5, 24)).toBeNull()
  })

  it('finds the earliest point the trailing window count reaches the threshold', () => {
    const times = ['2026-08-23T11:02:07Z', '2026-08-23T11:04:07Z']
    expect(findTrailingWindowCrossing(times, 2, 24)).toBe(new Date('2026-08-23T11:04:07Z').toISOString())
  })

  it('reproduces the production TropiTech Outreach bounce trip (issue #162)', () => {
    const times = [
      '2026-08-22T21:00:11.578676Z',
      '2026-08-22T21:02:12.686029Z',
      '2026-08-23T11:02:07.098705Z',
      '2026-08-23T11:04:07.501952Z',
      '2026-08-23T21:56:07.740013Z',
      '2026-08-24T01:02:09.353947Z',
      '2026-08-24T07:02:08.343091Z',
    ]
    expect(findTrailingWindowCrossing(times, 5, 24)).toBe(new Date('2026-08-24T07:02:08.343091Z').toISOString())
  })

  it('does not count entries outside the trailing window', () => {
    // Two clusters of 3 more than window-hours apart — never 5 within any
    // single trailing window.
    const times = [
      '2026-08-01T00:00:00Z', '2026-08-01T01:00:00Z', '2026-08-01T02:00:00Z',
      '2026-08-05T00:00:00Z', '2026-08-05T01:00:00Z',
    ]
    expect(findTrailingWindowCrossing(times, 5, 24)).toBeNull()
  })
})

describe('reconcileLegacyOutreachPause', () => {
  it('is a no-op when the pause already has a known source', async () => {
    const { db, calls } = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: true, outreach_pause_source: 'bounce_safety', outreach_pause_reason: 'r', outreach_paused_at: 't', outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    const result = await reconcileLegacyOutreachPause('ws-a')
    expect(result).toMatchObject({ reconciled: false, state: { source: 'bounce_safety', disposition: 'safety_recovery_not_supported' } })
    expect(calls.some((c) => c.table === 'caye_outreach_bounces')).toBe(false)
  })

  it('is a no-op when the workspace is not currently paused', async () => {
    const { db, calls } = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: false, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null, outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    const result = await reconcileLegacyOutreachPause('ws-a')
    expect(result).toMatchObject({ reconciled: false, state: { disposition: 'running' } })
    expect(calls.some((c) => c.table === 'caye_outreach_bounces')).toBe(false)
  })

  it('leaves the pause unknown_blocked when no bounce-threshold crossing can be found', async () => {
    const { db } = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: true, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null, outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null }],
      caye_outreach_bounces: [{ data: [{ created_at: '2026-08-23T11:02:07Z' }, { created_at: '2026-08-23T21:56:07Z' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    const result = await reconcileLegacyOutreachPause('ws-a')
    expect(result).toMatchObject({ reconciled: false, state: { source: 'unknown', disposition: 'unknown_blocked' } })
  })

  it('backfills bounce_safety provenance when a real crossing is found, and records an audit event', async () => {
    // workspace_ai_config queue serves two calls in order: the initial read,
    // then the update().eq().eq().is().select() write.
    const seeded = makeDb({
      workspace_ai_config: [
        { data: { outreach_autosend_paused: true, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null, outreach_bounce_threshold: 2, outreach_bounce_window_hours: 24 }, error: null },
        { data: [{ workspace_id: 'ws-a' }], error: null },
      ],
      caye_outreach_bounces: [{ data: [{ created_at: '2026-08-23T11:02:07Z' }, { created_at: '2026-08-23T11:04:07Z' }], error: null }],
      caye_outreach_pause_events: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)

    const result = await reconcileLegacyOutreachPause('ws-a')
    expect(result.reconciled).toBe(true)
    expect(result.state.source).toBe('bounce_safety')
    expect(result.state.disposition).toBe('safety_recovery_not_supported')
    const insertCall = seeded.calls.find((c) => c.table === 'caye_outreach_pause_events' && c.op === 'insert')
    expect(insertCall?.args[0]).toMatchObject({ workspace_id: 'ws-a', action: 'paused', source: 'bounce_safety', actor_role: 'system' })
  })

  it('is idempotent: a second call on an already-reconciled row is a no-op', async () => {
    const { db } = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: true, outreach_pause_source: 'bounce_safety', outreach_pause_reason: 'already reconciled', outreach_paused_at: '2026-08-24T07:02:08.343Z', outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    const result = await reconcileLegacyOutreachPause('ws-a')
    expect(result.reconciled).toBe(false)
    expect(result.state.source).toBe('bounce_safety')
  })

  it('never invents a source when the update loses a concurrent race, and reflects whatever won', async () => {
    const seeded = makeDb({
      workspace_ai_config: [
        { data: { outreach_autosend_paused: true, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null, outreach_bounce_threshold: 2, outreach_bounce_window_hours: 24 }, error: null },
        { data: [], error: null }, // update() matched zero rows — someone else won the race
        { data: { outreach_autosend_paused: true, outreach_pause_source: 'owner_manual', outreach_pause_reason: 'Paused by owner', outreach_paused_at: '2026-08-27T00:00:00Z' }, error: null },
      ],
      caye_outreach_bounces: [{ data: [{ created_at: '2026-08-23T11:02:07Z' }, { created_at: '2026-08-23T11:04:07Z' }], error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)
    const result = await reconcileLegacyOutreachPause('ws-a')
    expect(result.reconciled).toBe(false)
    expect(result.state.source).toBe('owner_manual')
  })
})

describe('resumeOwnerPausedOutreach', () => {
  it('does not write when the pause is not owner-resumable', async () => {
    const { db, calls } = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: true, outreach_pause_source: 'bounce_safety', outreach_pause_reason: 'r', outreach_paused_at: 't' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    const result = await resumeOwnerPausedOutreach('ws-a', 'owner')
    expect(result.disposition).toBe('safety_recovery_not_supported')
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('resumes an owner pause and records who authorized it', async () => {
    const seeded = makeDb({
      workspace_ai_config: [
        { data: { outreach_autosend_paused: true, outreach_pause_source: 'owner_manual', outreach_pause_reason: 'Paused by owner', outreach_paused_at: 't' }, error: null },
        { data: [{ workspace_id: 'ws-a' }], error: null },
      ],
      caye_outreach_pause_events: [{ data: null, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)
    const result = await resumeOwnerPausedOutreach('ws-a', 'founder')
    expect(result.disposition).toBe('running')
    const insertCall = seeded.calls.find((c) => c.table === 'caye_outreach_pause_events' && c.op === 'insert')
    expect(insertCall?.args[0]).toMatchObject({ workspace_id: 'ws-a', action: 'resumed', actor_role: 'founder' })
  })

  it('is idempotent: resuming an already-running workspace is a no-op', async () => {
    const { db, calls } = makeDb({
      workspace_ai_config: [{ data: { outreach_autosend_paused: false, outreach_pause_source: null, outreach_pause_reason: null, outreach_paused_at: null }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(db as never)
    const result = await resumeOwnerPausedOutreach('ws-a', 'owner')
    expect(result.disposition).toBe('running')
    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })
})
