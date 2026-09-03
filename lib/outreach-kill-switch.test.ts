import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./supabase-server', () => ({ createServiceClient: vi.fn() }))
vi.mock('./whatsapp/outbound', () => ({ sendFreeFormWhatsApp: vi.fn() }))
vi.mock('./outreach-pause-control', () => ({ recordBounceKillSwitchPause: vi.fn() }))

const { shouldTripKillSwitch, shouldTripKillSwitchForWindow, recordBounceAndMaybeTrip } = await import('./outreach-kill-switch')
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

describe('shouldTripKillSwitchForWindow — volume normalization', () => {
  const threshold = 5

  it('does not trip when the absolute floor is not reached, regardless of rate', () => {
    // 4 bounces out of 5 sends is an 80% rate, but too few events to act on.
    expect(shouldTripKillSwitchForWindow({ weightedBounceScore: 4, threshold, sendsInWindow: 5 }))
      .toEqual({ trip: false, rate: null })
  })

  it('trips at low volume exactly as the count-only rule did', () => {
    // 5 bounces / 20 sends = 25%, well over the 15% rate threshold.
    const v = shouldTripKillSwitchForWindow({ weightedBounceScore: 5, threshold, sendsInWindow: 20 })
    expect(v.trip).toBe(true)
    expect(v.rate).toBeCloseTo(0.25)
  })

  it('does NOT trip at restored volume on a healthy list — the regression this exists to prevent', () => {
    // The real failure mode: 50 first touches/day plus follow-ups is ~120
    // sends/day. At the measured 7.3% baseline that is ~9 bounces — well
    // past the absolute threshold of 5, but a perfectly normal cold-email
    // rate. The count-only rule would have halted all outreach daily.
    const v = shouldTripKillSwitchForWindow({ weightedBounceScore: 9, threshold, sendsInWindow: 120 })
    expect(v.trip).toBe(false)
    expect(v.rate).toBeCloseTo(0.075)
  })

  it('still trips at high volume when the rate genuinely deteriorates', () => {
    // Same 120 sends, but 30 bounces = 25%. Real problem, still caught.
    const v = shouldTripKillSwitchForWindow({ weightedBounceScore: 30, threshold, sendsInWindow: 120 })
    expect(v.trip).toBe(true)
    expect(v.rate).toBeCloseTo(0.25)
  })

  it('trips exactly at the rate threshold boundary', () => {
    expect(shouldTripKillSwitchForWindow({ weightedBounceScore: 15, threshold, sendsInWindow: 100 }).trip).toBe(true)
    expect(shouldTripKillSwitchForWindow({ weightedBounceScore: 14.9, threshold, sendsInWindow: 100 }).trip).toBe(false)
  })

  it('falls back to the absolute check when send volume is unknown, failing toward tripping', () => {
    expect(shouldTripKillSwitchForWindow({ weightedBounceScore: 6, threshold, sendsInWindow: null }))
      .toEqual({ trip: true, rate: null })
  })

  it('falls back to the absolute check when the window has zero recorded sends', () => {
    // Bounces with no sends on record means the telemetry disagrees with
    // itself; do not let that silently disable the kill switch.
    expect(shouldTripKillSwitchForWindow({ weightedBounceScore: 6, threshold, sendsInWindow: 0 }))
      .toEqual({ trip: true, rate: null })
  })
})
