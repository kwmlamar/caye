import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./supabase-server', () => ({ createServiceClient: vi.fn() }))
vi.mock('./whatsapp/outbound', () => ({ sendFreeFormWhatsApp: vi.fn() }))
vi.mock('./outreach-pause-control', () => ({ recordBounceKillSwitchPause: vi.fn() }))

const { shouldTripKillSwitch, recordBounceAndMaybeTrip } = await import('./outreach-kill-switch')
const { createServiceClient } = await import('./supabase-server')
const { recordBounceKillSwitchPause } = await import('./outreach-pause-control')
const { sendFreeFormWhatsApp } = await import('./whatsapp/outbound')

describe('shouldTripKillSwitch', () => {
  it('does not trip below the threshold', () => {
    expect(shouldTripKillSwitch(4, 5)).toBe(false)
  })

  it('trips exactly at the threshold', () => {
    expect(shouldTripKillSwitch(5, 5)).toBe(true)
  })

  it('trips above the threshold', () => {
    expect(shouldTripKillSwitch(9, 5)).toBe(true)
  })

  it('does not trip with zero bounces', () => {
    expect(shouldTripKillSwitch(0, 5)).toBe(false)
  })

  it('takes a fractional (severity-weighted) score, not just integers', () => {
    // 4 soft bounces at weight 0.25 each = 1.0, below a threshold of 2
    expect(shouldTripKillSwitch(1, 2)).toBe(false)
    // 1 hard (weight 1) + 4 soft (weight 1) = 2, at the threshold
    expect(shouldTripKillSwitch(2, 2)).toBe(true)
  })
})

// Mock Supabase double for recordBounceAndMaybeTrip. Each table gets its own
// FIFO queue of responses so a test can script exactly what each call in the
// function's sequence sees, mirroring lib/outreach-founder-bounce-override.test.ts's
// pattern. insert()/maybeSingle() resolve immediately; select().eq().gte()
// chains resolve lazily via `then` so both the head-count fallback path and
// the classification-rows path can share the same builder shape.
type MockResult = { data: unknown; error: unknown; count?: number }
function makeDb(queues: Record<string, MockResult[]>) {
  const inserts: Array<{ table: string; row: unknown }> = []
  function chain(table: string) {
    const resolve = (): Promise<MockResult> =>
      Promise.resolve(queues[table]?.shift() ?? { data: null, error: null })
    const builder: Record<string, (...args: unknown[]) => unknown> & PromiseLike<MockResult> = {
      select: () => builder,
      eq: () => builder,
      gte: () => builder,
      insert: (row: unknown) => {
        inserts.push({ table, row })
        return resolve()
      },
      maybeSingle: () => resolve(),
      then: (onfulfilled: (value: MockResult) => unknown) => resolve().then(onfulfilled),
    } as never
    return builder
  }
  return { db: { from: (table: string) => chain(table) }, inserts }
}

beforeEach(() => vi.clearAllMocks())

describe('recordBounceAndMaybeTrip — severity weighting', () => {
  const detail = { classification: 'hard' as const, recipient: 'dead@example.com', sourceSubject: 'Undeliverable' }

  it('does not trip on soft bounces alone even at the raw-count threshold', async () => {
    const seeded = makeDb({
      caye_outreach_bounces: [
        { data: null, error: null }, // insert
        { // classification rows in window: 5 soft bounces, weight 0.25 each = 1.25, threshold 5
          data: [
            { classification: 'soft' }, { classification: 'soft' }, { classification: 'soft' },
            { classification: 'soft' }, { classification: 'soft' },
          ],
          error: null,
        },
      ],
      workspace_ai_config: [
        { data: { outreach_autosend_paused: false, outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)

    await recordBounceAndMaybeTrip('ws-a', { classification: 'soft', recipient: 'full@example.com', sourceSubject: 'Delivery delayed' })

    expect(recordBounceKillSwitchPause).not.toHaveBeenCalled()
    expect(sendFreeFormWhatsApp).not.toHaveBeenCalled()
  })

  it('trips on hard bounces well under the raw-count threshold', async () => {
    const seeded = makeDb({
      caye_outreach_bounces: [
        { data: null, error: null }, // insert
        { data: [{ classification: 'hard' }, { classification: 'hard' }], error: null }, // 2 hard = weight 2, threshold 2
      ],
      workspace_ai_config: [
        { data: { outreach_autosend_paused: false, outreach_bounce_threshold: 2, outreach_bounce_window_hours: 24 }, error: null },
      ],
      platform_settings: [{ data: { value: '+15550001111' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)
    vi.mocked(sendFreeFormWhatsApp).mockResolvedValue({ status: 'sent' } as never)

    await recordBounceAndMaybeTrip('ws-a', detail)

    expect(recordBounceKillSwitchPause).toHaveBeenCalledTimes(1)
    expect(recordBounceKillSwitchPause).toHaveBeenCalledWith('ws-a', expect.stringContaining('2 hard'))
    expect(sendFreeFormWhatsApp).toHaveBeenCalledTimes(1)
  })

  it('treats legacy/unclassified rows (classification null) as conservative weight 1, same as hard', async () => {
    const seeded = makeDb({
      caye_outreach_bounces: [
        { data: null, error: null }, // insert
        { data: [{ classification: null }, { classification: null }], error: null }, // 2 legacy rows
      ],
      workspace_ai_config: [
        { data: { outreach_autosend_paused: false, outreach_bounce_threshold: 2, outreach_bounce_window_hours: 24 }, error: null },
      ],
      platform_settings: [{ data: { value: '+15550001111' }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)
    vi.mocked(sendFreeFormWhatsApp).mockResolvedValue({ status: 'sent' } as never)

    await recordBounceAndMaybeTrip('ws-a', { classification: 'unknown', recipient: null, sourceSubject: 'Mail delivery failed' })

    expect(recordBounceKillSwitchPause).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the workspace is already paused', async () => {
    const seeded = makeDb({
      caye_outreach_bounces: [{ data: null, error: null }], // insert only, no window query reached
      workspace_ai_config: [{ data: { outreach_autosend_paused: true, outreach_bounce_threshold: 2, outreach_bounce_window_hours: 24 }, error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)

    await recordBounceAndMaybeTrip('ws-a', detail)

    expect(recordBounceKillSwitchPause).not.toHaveBeenCalled()
  })

  it('falls back to a bare insert when the detail columns are not deployed yet', async () => {
    const seeded = makeDb({
      caye_outreach_bounces: [
        { data: null, error: { message: 'column "classification" does not exist' } }, // detailed insert fails
        { data: null, error: null }, // fallback bare insert succeeds
        { data: [], error: null }, // window query (empty, below threshold)
      ],
      workspace_ai_config: [
        { data: { outreach_autosend_paused: false, outreach_bounce_threshold: 5, outreach_bounce_window_hours: 24 }, error: null },
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(seeded.db as never)

    await recordBounceAndMaybeTrip('ws-a', detail)

    expect(seeded.inserts).toHaveLength(2)
    expect(seeded.inserts[1].row).toEqual({ workspace_id: 'ws-a' })
    expect(recordBounceKillSwitchPause).not.toHaveBeenCalled()
  })
})
