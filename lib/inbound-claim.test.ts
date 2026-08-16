import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

type InsertResult = { data: { id: string } | null; error: { code?: string; message: string } | null }

function fakeSupabase(result: InsertResult) {
  return {
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => result,
        }),
      }),
    }),
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase-server'
import { claimInboundMessage } from './inbound-claim'

describe('claimInboundMessage (2026-08-16, global Zoho cutover — returns the claimed row id)', () => {
  it('returns the inserted row id on success — needed for triggeringMessageId (a real FK elsewhere)', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      fakeSupabase({ data: { id: 'msg-uuid-1' }, error: null }) as never
    )
    const result = await claimInboundMessage('conv1', 'zoho_123', { content: 'hi', sentAt: '2026-08-16T00:00:00Z' })
    expect(result).toEqual({ claimed: true, messageId: 'msg-uuid-1' })
  })

  it('returns claimed:false without a message id on a unique-violation race', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      fakeSupabase({ data: null, error: { code: '23505', message: 'duplicate' } }) as never
    )
    const result = await claimInboundMessage('conv1', 'zoho_123', { content: 'hi', sentAt: '2026-08-16T00:00:00Z' })
    expect(result).toEqual({ claimed: false })
  })

  it('returns claimed:false with the error message on a genuine failure', async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      fakeSupabase({ data: null, error: { code: '42501', message: 'permission denied' } }) as never
    )
    const result = await claimInboundMessage('conv1', 'zoho_123', { content: 'hi', sentAt: '2026-08-16T00:00:00Z' })
    expect(result).toEqual({ claimed: false, error: 'permission denied' })
  })
})
