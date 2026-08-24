import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
vi.mock('server-only', () => ({}))
vi.mock('./supabase-server', () => ({ createServiceClient: () => ({ rpc }) }))

import { reserveFirstTouchCapacity } from './outreach-first-touch-capacity'

describe('reserveFirstTouchCapacity', () => {
  beforeEach(() => rpc.mockReset())

  it('uses the atomic workspace/day reservation RPC rather than a stale count', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await expect(reserveFirstTouchCapacity('ws-1', 'lead-1', new Date('2026-08-24T12:00:00Z'))).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith('reserve_outreach_first_touch_capacity', expect.objectContaining({
      p_workspace_id: 'ws-1', p_lead_id: 'lead-1', p_day: '2026-08-24', p_cap: 50,
    }))
  })

  it('fails closed when the capacity reservation cannot be established', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })
    await expect(reserveFirstTouchCapacity('ws-1', 'lead-1', new Date())).rejects.toThrow('could not reserve first-touch capacity')
  })
})
