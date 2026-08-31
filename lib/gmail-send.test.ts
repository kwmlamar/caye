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

import { sendGmailReply } from './gmail-send'

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
})
