import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runPerceptionFreshnessSweep: vi.fn(),
}))

vi.mock('@/lib/perception/freshness', () => ({
  runPerceptionFreshnessSweep: mocks.runPerceptionFreshnessSweep,
}))

import { GET } from './route'

function request(secret?: string, legacy = false) {
  return new NextRequest('http://localhost/api/caye/perception-freshness', {
    method: 'GET',
    headers: secret
      ? legacy
        ? { 'x-cron-secret': secret }
        : { authorization: `Bearer ${secret}` }
      : {},
  })
}

describe('perception freshness cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    mocks.runPerceptionFreshnessSweep.mockResolvedValue({
      status: 'completed',
      checked_at: '2026-08-30T19:30:00.000Z',
      sources_marked_stale: 1,
      capabilities_downgraded: 1,
      devices_marked_stale: 1,
      events_emitted: 1,
    })
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
  })

  it('fails closed when cron authorization is not configured', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(request())

    expect(res.status).toBe(503)
    expect(mocks.runPerceptionFreshnessSweep).not.toHaveBeenCalled()
  })

  it('rejects a missing or wrong secret before running the sweep', async () => {
    const missing = await GET(request())
    expect(missing.status).toBe(401)

    const wrong = await GET(request('wrong-secret'))
    expect(wrong.status).toBe(401)
    expect(mocks.runPerceptionFreshnessSweep).not.toHaveBeenCalled()
  })

  it('accepts the canonical bearer cron secret', async () => {
    const res = await GET(request('cron-secret'))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'completed', sources_marked_stale: 1 })
    expect(mocks.runPerceptionFreshnessSweep).toHaveBeenCalledTimes(1)
  })

  it('keeps compatibility with the existing x-cron-secret scheduler header', async () => {
    const res = await GET(request('cron-secret', true))

    expect(res.status).toBe(200)
    expect(mocks.runPerceptionFreshnessSweep).toHaveBeenCalledTimes(1)
  })

  it('returns 500 when the durable sweep fails so scheduling can retry', async () => {
    mocks.runPerceptionFreshnessSweep.mockRejectedValue(new Error('database unavailable'))

    const res = await GET(request('cron-secret'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Perception freshness sweep failed' })
  })
})
