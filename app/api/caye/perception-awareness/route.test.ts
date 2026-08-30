import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({ rpc: mocks.rpc }),
}))

import { GET } from './route'

function request(secret = 'cron-secret') {
  return new NextRequest('http://localhost/api/caye/perception-awareness', {
    headers: { authorization: `Bearer ${secret}` },
  })
}

describe('perception awareness cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
  })

  it('fails closed when cron authentication is wrong', async () => {
    const response = await GET(request('wrong'))
    expect(response.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('runs the bounded canonical perception cycle', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'ok', processed: 2, changed: 1, unchanged: 1, failed: 0 },
      error: null,
    })

    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ processed: 2, changed: 1, unchanged: 1 })
    expect(mocks.rpc).toHaveBeenCalledWith('run_workspace_event_perception_cycle', { p_limit: 100 })
  })

  it('returns a retryable failure when the source database is temporarily unavailable', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })
    const response = await GET(request())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'Perception cycle unavailable; scheduler will retry on the next run.',
    })
  })
})
