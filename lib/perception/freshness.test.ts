import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
}))

import { runPerceptionFreshnessSweep } from './freshness'

describe('runPerceptionFreshnessSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes an explicit timestamp into the atomic database sweep', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        status: 'completed',
        checked_at: '2026-08-30T19:30:00.000Z',
        sources_marked_stale: 2,
        capabilities_downgraded: 2,
        devices_marked_stale: 1,
        events_emitted: 2,
      },
      error: null,
    })

    const result = await runPerceptionFreshnessSweep(new Date('2026-08-30T19:30:00.000Z'))

    expect(mocks.rpc).toHaveBeenCalledWith('refresh_perception_freshness', {
      p_now: '2026-08-30T19:30:00.000Z',
    })
    expect(result).toMatchObject({
      status: 'completed',
      sources_marked_stale: 2,
      capabilities_downgraded: 2,
      devices_marked_stale: 1,
      events_emitted: 2,
    })
  })

  it('fails closed when the database sweep fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(runPerceptionFreshnessSweep()).rejects.toThrow(
      'Perception freshness sweep failed: database unavailable',
    )
  })

  it('rejects malformed database results instead of reporting success', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'mystery' }, error: null })

    await expect(runPerceptionFreshnessSweep()).rejects.toThrow(
      'Perception freshness sweep returned an invalid result',
    )
  })

  it('rejects invalid timestamps before database access', async () => {
    await expect(runPerceptionFreshnessSweep(new Date('invalid'))).rejects.toThrow(
      'Invalid freshness sweep timestamp',
    )
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
