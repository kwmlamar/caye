import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { getGmailContext } = vi.hoisted(() => ({ getGmailContext: vi.fn() }))
vi.mock('./gmail-token', () => ({ getGmailContext }))
vi.mock('./supabase-server', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    })),
  })),
}))

import { sendGmailReply, sendGmailReplyWithAttachments } from './gmail-send'
import { DispatchAmbiguousError } from './whatsapp/channel-dispatch'

describe('sendGmailReply observe-only safety', () => {
  it('fails closed before any Gmail network send when the account is observe-only', async () => {
    getGmailContext.mockResolvedValue({
      accountRow: { metadata: { observe_only: true } },
      accessToken: 'token',
      emailAddress: 'owner@example.com',
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(sendGmailReply({
      to: 'customer@example.com',
      subject: 'Re: Estimate',
      body: 'Draft response',
      gmailThreadId: 'thread-1',
      conversationId: 'conversation-1',
      workspaceId: 'workspace-1',
    })).rejects.toThrow(/observe-only mode/i)

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('keeps the recipient identity intact and attaches the generated PDF', async () => {
    getGmailContext.mockResolvedValue({ accountRow: { metadata: {} }, accessToken: 'token', emailAddress: 'owner@example.com' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'gm-1', threadId: 'thread-1' }), { status: 200 }))
    await sendGmailReplyWithAttachments({
      to: 'nicole.butcher+freight@example.test', subject: 'Re: DR-12345', body: 'Attached.', gmailThreadId: 'thread-1', conversationId: 'conversation-1', workspaceId: 'workspace-1',
      attachments: [{ filename: 'freight-DR-12345.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-fixture') }],
    })
    const payload = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { raw: string }
    const padded = payload.raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.raw.length % 4) % 4)
    const mime = Buffer.from(padded, 'base64').toString('utf8')
    expect(mime).toContain('To: nicole.butcher+freight@example.test')
    expect(mime).toContain('filename="freight-DR-12345.pdf"')
    expect(mime).toContain(Buffer.from('%PDF-fixture').toString('base64'))
    fetchSpy.mockRestore()
  })

  it('also blocks attachment sends for observe-only Gmail', async () => {
    getGmailContext.mockResolvedValue({ accountRow: { metadata: { observe_only: true } }, accessToken: 'token', emailAddress: 'owner@example.com' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(sendGmailReplyWithAttachments({ to: 'x@example.test', subject: 'x', body: 'x', gmailThreadId: 't', conversationId: 'c', workspaceId: 'w', attachments: [{ filename: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF') }] })).rejects.toThrow(/observe-only/)
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore()
  })

  it('classifies a network/provider failure as an uncertain outcome', async () => {
    getGmailContext.mockResolvedValue({ accountRow: { metadata: {} }, accessToken: 'token', emailAddress: 'owner@example.com' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'))
    await expect(sendGmailReplyWithAttachments({ to: 'x@example.test', subject: 'x', body: 'x', gmailThreadId: 't', conversationId: 'c', workspaceId: 'w', attachments: [{ filename: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF') }] }))
      .rejects.toMatchObject({ name: 'DispatchAmbiguousError', definitelySent: false } satisfies Partial<DispatchAmbiguousError>)
    expect(fetchSpy).toHaveBeenCalledTimes(1); fetchSpy.mockRestore()
  })

  it('keeps a definite pre-provider failure as an ordinary retryable error', async () => {
    getGmailContext.mockRejectedValue(new Error('token unavailable'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const promise = sendGmailReplyWithAttachments({ to: 'x@example.test', subject: 'x', body: 'x', gmailThreadId: 't', conversationId: 'c', workspaceId: 'w', attachments: [{ filename: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF') }] })
    await expect(promise).rejects.toThrow('token unavailable')
    await expect(promise).rejects.not.toBeInstanceOf(DispatchAmbiguousError)
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore()
  })
})
