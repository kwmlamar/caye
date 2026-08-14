import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { afterSpy, enqueue, drain } = vi.hoisted(() => ({
  afterSpy: vi.fn(), enqueue: vi.fn(async () => ({ queued: true, alreadyQueued: false })), drain: vi.fn(async () => {}),
}))
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: afterSpy }))
vi.mock('@/lib/pending-operations', () => ({ enqueueOperation: enqueue }))
vi.mock('@/lib/pending-operations-worker', () => ({ drainPendingOperationsSafely: drain }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'ws-live', workspace_kind: 'internal_sales', plan: 'pro' }, error: null }) }) }) }) }) }))

import { GET } from './route'

describe('outreach sourcing scheduler endpoint', () => {
  it('durably enqueues once and returns 202 without awaiting slow sourcing', async () => {
    const response = await GET(new NextRequest('http://localhost/api/caye/outreach-sourcing-scan'))
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ status: 'accepted', already_queued: false })
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ operation: 'outreach_sourcing', delayMs: 0 }))
    expect(afterSpy).toHaveBeenCalledOnce()
  })
})
