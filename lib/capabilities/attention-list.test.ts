import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabaseClient } from '@/lib/supabase-test-support/fake-supabase-client'

const mocks = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: mocks.createServiceClient }))

import { attentionListCapability } from './attention-list'

const baseContext = {
  actor: { kind: 'founder' as const, userId: 'founder-1' },
  caller: 'external_reasoner' as const,
}

describe('attention.list capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects unbounded operator scope before touching the database', async () => {
    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: null },
    })

    expect(mocks.createServiceClient).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'invalid_scope', retryable: false })
  })

  it('returns a safe, prioritized workspace attention list without raw internal context', async () => {
    const client = createFakeSupabaseClient()
    client.seed('caye_escalations', [
      {
        id: 'esc-no-booking',
        workspace_id: 'workspace-a',
        conversation_id: 'conv-2',
        category: 'policy',
        customer_facing_message: 'A customer needs your judgment.',
        internal_context: 'A normal safe explanation.',
        created_at: '2026-08-27T10:00:00Z',
        owner_responded_at: null,
        expired_at: null,
      },
      {
        id: 'esc-booking',
        workspace_id: 'workspace-a',
        conversation_id: 'conv-1',
        category: 'sensitive',
        customer_facing_message: 'Customer needs a refund decision. Approve it?',
        internal_context: 'supabase tool_call caye_escalations internal_context row',
        created_at: '2026-08-28T10:00:00Z',
        owner_responded_at: null,
        expired_at: null,
      },
    ])
    client.seed('unified_conversations', [
      { id: 'conv-1', customer_name: 'Customer One' },
      { id: 'conv-2', customer_name: 'Customer Two' },
    ])
    client.seed('bookings', [
      {
        conversation_id: 'conv-1',
        booking_date: '2026-09-01',
        number_of_people: 2,
        status: 'confirmed',
        service: { name: 'Island Tour' },
      },
    ])
    mocks.createServiceClient.mockReturnValue(client)

    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(client.calls('caye_escalations')).toContainEqual(['eq', 'workspace_id', 'workspace-a'])
    expect(client.calls('caye_escalations')).toContainEqual(['is', 'owner_responded_at', null])
    expect(client.calls('caye_escalations')).toContainEqual(['is', 'expired_at', null])
    expect(result.status).toBe('observed')
    expect(result.data?.map((item) => item.id)).toEqual(['esc-booking', 'esc-no-booking'])
    expect(result.data?.[0]).toMatchObject({
      customerName: 'Customer One',
      summary: 'Customer needs a refund decision.',
      decision: 'Approve it?',
      booking: { serviceName: 'Island Tour', bookingDate: '2026-09-01', numberOfPeople: 2 },
    })
    expect(JSON.stringify(result.data)).not.toContain('supabase')
    expect(JSON.stringify(result.data)).not.toContain('internal_context')
    expect(result.evidence).toEqual([
      { kind: 'record', id: 'esc-booking' },
      { kind: 'record', id: 'esc-no-booking' },
    ])
  })

  it('treats an empty workspace queue as a successful observation', async () => {
    const client = createFakeSupabaseClient()
    client.seed('caye_escalations', [])
    mocks.createServiceClient.mockReturnValue(client)

    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result).toMatchObject({ status: 'observed', data: [], evidence: [], failure: null })
  })

  it('fails explicitly when the attention read fails', async () => {
    const client = createFakeSupabaseClient()
    client.seed('caye_escalations', [], { error: { message: 'db down' } })
    mocks.createServiceClient.mockReturnValue(client)

    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'unavailable', retryable: true })
  })
})
