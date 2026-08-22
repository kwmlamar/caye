import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const mocks = vi.hoisted(() => ({
  dispatchOperatorReply: vi.fn(async () => ({ channelType: 'email', messageId: 'msg-1' })),
  resolveOpenEscalations: vi.fn(async () => undefined),
}))

vi.mock('@/lib/whatsapp/channel-dispatch', () => ({ dispatchOperatorReply: mocks.dispatchOperatorReply }))
vi.mock('../write-low/_guards', () => ({
  assertConversationOwnedByWorkspace: vi.fn(async () => ({ ok: true })),
  resolveOpenEscalations: mocks.resolveOpenEscalations,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'unified_messages') {
        const query = {
          eq: () => query,
          order: () => query,
          limit: async () => ({ data: [{ content: 'The pickup is at 9:00 AM.' }] }),
        }
        return { select: () => query }
      }
      if (table === 'unified_conversations') {
        return { update: () => ({ eq: async () => ({ error: null }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { sendReply } from './send-reply'

describe('send_reply owner-confirmed logistics', () => {
  beforeEach(() => mocks.dispatchOperatorReply.mockClear())

  it('sends an owner-approved time change even when the prior customer thread has the old time', async () => {
    const result = await sendReply.execute(
      { conversation_id: 'conv-1', body: 'Your pickup time has been adjusted to 9:30 AM.' },
      { workspaceId: 'ws-1', callerRole: 'owner', operatorId: 1, requestId: 'confirmed-turn' }
    )

    expect(result.ok).toBe(true)
    expect(mocks.dispatchOperatorReply).toHaveBeenCalledWith(
      'conv-1',
      'Your pickup time has been adjusted to 9:30 AM.',
      'caye-dashboard'
    )
  })

  it('still blocks an unapproved logistics invention', async () => {
    const result = await sendReply.execute(
      { conversation_id: 'conv-1', body: 'Your pickup time has been adjusted to 9:30 AM.' },
      { workspaceId: 'ws-1', callerRole: 'staff', operatorId: null, requestId: 'unapproved-turn' }
    )

    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error_code : null).toBe('UNGROUNDED_LOGISTICS_TIME')
    expect(mocks.dispatchOperatorReply).not.toHaveBeenCalled()
  })
})
