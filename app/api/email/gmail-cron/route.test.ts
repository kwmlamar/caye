import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const runGmailPoll = vi.fn()
vi.mock('@/app/api/email/gmail-poll/route', () => ({ runGmailPoll }))

import { GET } from './route'

describe('GET /api/email/gmail-cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CRON_SECRET = 'cron-secret'
    runGmailPoll.mockResolvedValue({ accounts: 1, results: [] })
  })

  it('accepts Vercel Authorization bearer auth and runs Gmail polling', async () => {
    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron', {
      headers: { Authorization: 'Bearer cron-secret' },
    })

    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accounts: 1, results: [] })
    expect(runGmailPoll).toHaveBeenCalledTimes(1)
  })

  it('keeps x-cron-secret compatibility', async () => {
    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron', {
      headers: { 'x-cron-secret': 'cron-secret' },
    })

    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(runGmailPoll).toHaveBeenCalledTimes(1)
  })

  it('rejects unauthenticated cron requests', async () => {
    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron')

    const res = await GET(req)

    expect(res.status).toBe(401)
    expect(runGmailPoll).not.toHaveBeenCalled()
  })
})
