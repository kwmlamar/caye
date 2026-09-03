import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createServiceClient } = vi.hoisted(() => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient }))

import { attentionListCapability } from './attention-list'

type QueryResult = { data: unknown[] | null; error: { message: string } | null }

function makeQuery(result: QueryResult) {
  const calls: Array<[string, ...unknown[]]> = []
  const query: Record<string, unknown> = {
    calls,
    then(resolve: (value: QueryResult) => unknown) {
      return Promise.resolve(result).then(resolve)
    },
  }
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'in', 'neq'] as const) {
    query[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, ...args])
      return query
    })
  }
  return query
}

const baseContext = {
  actor: { kind: 'founder' as const, userId: 'founder-1' },
  caller: 'external_reasoner' as const,
}

function clientFor(results: Record<string, QueryResult>) {
  const queries = new Map(Object.entries(results).map(([table, result]) => [table, makeQuery(result)]))
  return {
    client: {
      from: vi.fn((table: string) => {
        const query = queries.get(table)
        if (!query) throw new Error(`unexpected table ${table}`)
        return query
      }),
    },
    query(table: string) {
      return queries.get(table) as ReturnType<typeof makeQuery>
    },
  }
}

describe('attention.list capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects unbounded operator scope before touching the database', async () => {
    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: null },
    })

    expect(createServiceClient).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'invalid_scope', retryable: false })
  })

  it('returns a safe, prioritized workspace attention list without raw internal context', async () => {
    const { client, query } = clientFor({
      caye_escalations: {
        data: [
          {
            id: 'esc-no-booking',
            conversation_id: 'conv-2',
            category: 'policy',
            customer_facing_message: 'A customer needs your judgment.',
            internal_context: 'A normal safe explanation.',
            created_at: '2026-08-27T10:00:00Z',
          },
          {
            id: 'esc-booking',
            conversation_id: 'conv-1',
            category: 'sensitive',
            customer_facing_message: 'Customer needs a refund decision. Approve it?',
            internal_context: 'supabase tool_call caye_escalations internal_context row',
            created_at: '2026-08-28T10:00:00Z',
          },
        ],
        error: null,
      },
      unified_conversations: {
        data: [
          { id: 'conv-1', customer_name: 'Customer One' },
          { id: 'conv-2', customer_name: 'Customer Two' },
        ],
        error: null,
      },
      bookings: {
        data: [
          {
            conversation_id: 'conv-1',
            booking_date: '2026-09-01',
            number_of_people: 2,
            service: { name: 'Island Tour' },
          },
        ],
        error: null,
      },
    })
    createServiceClient.mockReturnValue(client)

    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(query('caye_escalations').calls).toContainEqual(['eq', 'workspace_id', 'workspace-a'])
    expect(query('caye_escalations').calls).toContainEqual(['is', 'owner_responded_at', null])
    expect(query('caye_escalations').calls).toContainEqual(['is', 'expired_at', null])
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
    const { client } = clientFor({ caye_escalations: { data: [], error: null } })
    createServiceClient.mockReturnValue(client)

    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result).toMatchObject({ status: 'observed', data: [], evidence: [], failure: null })
  })

  it('fails explicitly when the attention read fails', async () => {
    const { client } = clientFor({ caye_escalations: { data: null, error: { message: 'db down' } } })
    createServiceClient.mockReturnValue(client)

    const result = await attentionListCapability.execute({}, {
      ...baseContext,
      scope: { workspaceId: 'workspace-a' },
    })

    expect(result.status).toBe('failed')
    expect(result.failure).toMatchObject({ code: 'unavailable', retryable: true })
  })
})
