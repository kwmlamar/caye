import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const { runGmailPoll } = vi.hoisted(() => ({ runGmailPoll: vi.fn() }))
vi.mock('@/app/api/email/gmail-poll/route', () => ({ runGmailPoll }))

const { syncRecentGmailAttachmentEvidence } = vi.hoisted(() => ({
  syncRecentGmailAttachmentEvidence: vi.fn(),
}))
vi.mock('@/lib/artifacts/gmail-attachment-sync', () => ({ syncRecentGmailAttachmentEvidence }))

import { GET } from './route'

const ATTACHMENT_EVIDENCE = {
  accounts: 1,
  messages: 3,
  attachments: 2,
  deduped: 1,
  freightRequests: 1,
  freightRelations: 1,
  errors: 0,
}

describe('GET /api/email/gmail-cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.CRON_SECRET = 'cron-secret'
    runGmailPoll.mockResolvedValue({ accounts: 1, results: [] })
    syncRecentGmailAttachmentEvidence.mockResolvedValue(ATTACHMENT_EVIDENCE)
  })

  it('accepts Vercel Authorization bearer auth and runs Gmail polling', async () => {
    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron', {
      headers: { Authorization: 'Bearer cron-secret' },
    })

    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accounts: 1,
      results: [],
      attachmentEvidence: ATTACHMENT_EVIDENCE,
    })
    expect(runGmailPoll).toHaveBeenCalledTimes(1)
    expect(syncRecentGmailAttachmentEvidence).toHaveBeenCalledTimes(1)
  })

  it('keeps x-cron-secret compatibility', async () => {
    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron', {
      headers: { 'x-cron-secret': 'cron-secret' },
    })

    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accounts: 1,
      results: [],
      attachmentEvidence: ATTACHMENT_EVIDENCE,
    })
    expect(runGmailPoll).toHaveBeenCalledTimes(1)
  })

  it('rejects unauthenticated cron requests', async () => {
    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron')

    const res = await GET(req)

    expect(res.status).toBe(401)
    expect(runGmailPoll).not.toHaveBeenCalled()
    expect(syncRecentGmailAttachmentEvidence).not.toHaveBeenCalled()
  })

  // A bug in the newer attachment-evidence pass must not be reported as a
  // Gmail polling failure. The poll has already committed its work by then,
  // and a 500 here would tell cron monitoring that email ingestion is down
  // when it succeeded.
  it('still reports the successful poll when the attachment evidence pass fails', async () => {
    syncRecentGmailAttachmentEvidence.mockRejectedValue(new Error('attachment sync failed'))

    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron', {
      headers: { Authorization: 'Bearer cron-secret' },
    })

    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accounts: 1,
      results: [],
      attachmentEvidence: null,
      attachmentEvidenceError: 'attachment sync failed',
    })
    expect(runGmailPoll).toHaveBeenCalledTimes(1)
  })

  // The poll itself failing is still a real cron failure.
  it('returns 500 when the Gmail poll itself fails, without running the attachment pass', async () => {
    runGmailPoll.mockRejectedValue(new Error('gmail poll failed'))

    const req = new NextRequest('https://www.meetcaye.com/api/email/gmail-cron', {
      headers: { Authorization: 'Bearer cron-secret' },
    })

    const res = await GET(req)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'gmail poll failed' })
    expect(syncRecentGmailAttachmentEvidence).not.toHaveBeenCalled()
  })
})
