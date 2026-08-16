import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { persistFrontDeskAgentTurns, loadAgentTurnsForTriggers } from './caye-frontdesk-agent-turns'

/**
 * Minimal thenable query-builder fake — supports the exact chains this
 * module calls (.from().select()/.insert().eq()/.in()/.order()) and
 * resolves like the real Supabase client (awaiting the builder itself
 * yields {data,error,count}).
 */
function fakeSupabase(opts: {
  insertResults?: Array<{ error: { code: string; message: string } | null }>
  countResult?: { count: number | null }
  selectResult?: { data: unknown[] | null; error: { message: string } | null }
}) {
  const insertCalls: unknown[] = []
  let insertIdx = 0
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.eq = vi.fn(chain)
  builder.in = vi.fn(chain)
  builder.order = vi.fn(() => Promise.resolve(opts.selectResult ?? { data: [], error: null }))
  builder.select = vi.fn((_cols?: string, sel?: { count?: string; head?: boolean }) => {
    if (sel?.count) {
      // count-check path: .select(..., {count:'exact', head:true}).eq().eq() resolves directly
      const countResult = opts.countResult ?? { count: 0 }
      const countBuilder: Record<string, unknown> = {}
      countBuilder.eq = vi.fn(() => countBuilder)
      // final await happens after two .eq() calls; make the object thenable
      countBuilder.then = (
        onfulfilled?: ((value: unknown) => unknown) | null,
        onrejected?: ((reason: unknown) => unknown) | null
      ) => Promise.resolve(countResult).then(onfulfilled ?? undefined, onrejected ?? undefined)
      return countBuilder
    }
    return builder
  })
  builder.insert = vi.fn((payload: unknown) => {
    insertCalls.push(payload)
    const result = opts.insertResults?.[insertIdx] ?? { error: null }
    insertIdx++
    return Promise.resolve(result)
  })
  const client = { from: vi.fn(() => builder), insertCalls }
  return client
}

describe('persistFrontDeskAgentTurns', () => {
  it('inserts every turn in order with an incrementing sequence', async () => {
    const client = fakeSupabase({ countResult: { count: 0 } })
    const turns = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'lookup_price', input: {} }] },
      { role: 'assistant' as const, content: 'Here you go' },
    ]
    const result = await persistFrontDeskAgentTurns(
      client as never,
      'ws1',
      'conv1',
      'msg1',
      turns
    )
    expect(result).toEqual({ persisted: 3, alreadyPersisted: false })
    expect(client.insertCalls).toEqual([
      expect.objectContaining({ sequence: 0, role: 'user', triggering_message_id: 'msg1' }),
      expect.objectContaining({ sequence: 1, role: 'assistant' }),
      expect.objectContaining({ sequence: 2, role: 'assistant' }),
    ])
  })

  it('is a no-op when turns already persisted for this trigger (idempotent retry)', async () => {
    const client = fakeSupabase({ countResult: { count: 2 } })
    const result = await persistFrontDeskAgentTurns(
      client as never,
      'ws1',
      'conv1',
      'msg1',
      [{ role: 'user', content: 'hi' }]
    )
    expect(result).toEqual({ persisted: 0, alreadyPersisted: true })
    expect(client.insertCalls).toHaveLength(0)
  })

  it('treats a unique-violation on insert as a benign already-persisted skip, not an error', async () => {
    const client = fakeSupabase({
      countResult: { count: 0 },
      insertResults: [{ error: { code: '23505', message: 'duplicate key' } }],
    })
    const result = await persistFrontDeskAgentTurns(
      client as never,
      'ws1',
      'conv1',
      'msg1',
      [{ role: 'user', content: 'hi' }]
    )
    expect(result.persisted).toBe(0)
  })

  it('rethrows a non-unique-violation insert error', async () => {
    const client = fakeSupabase({
      countResult: { count: 0 },
      insertResults: [{ error: { code: '42501', message: 'permission denied' } }],
    })
    await expect(
      persistFrontDeskAgentTurns(client as never, 'ws1', 'conv1', 'msg1', [{ role: 'user', content: 'hi' }])
    ).rejects.toBeTruthy()
  })

  it('is a no-op with no DB call when there are no turns to persist', async () => {
    const client = fakeSupabase({})
    const result = await persistFrontDeskAgentTurns(client as never, 'ws1', 'conv1', 'msg1', [])
    expect(result).toEqual({ persisted: 0, alreadyPersisted: false })
    expect(client.from).not.toHaveBeenCalled()
  })
})

describe('loadAgentTurnsForTriggers', () => {
  it('groups rows by triggering_message_id, preserving sequence order', async () => {
    const client = fakeSupabase({
      selectResult: {
        data: [
          { id: 'r1', triggering_message_id: 'msg1', role: 'user', claude_format: { role: 'user', content: 'hi' }, created_at: 't1', sequence: 0 },
          { id: 'r2', triggering_message_id: 'msg1', role: 'assistant', claude_format: { role: 'assistant', content: 'hey' }, created_at: 't2', sequence: 1 },
          { id: 'r3', triggering_message_id: 'msg2', role: 'user', claude_format: { role: 'user', content: 'again' }, created_at: 't3', sequence: 0 },
        ],
        error: null,
      },
    })
    const map = await loadAgentTurnsForTriggers(client as never, 'conv1', ['msg1', 'msg2'])
    expect(map.get('msg1')).toHaveLength(2)
    expect(map.get('msg1')?.[0].role).toBe('user')
    expect(map.get('msg1')?.[1].role).toBe('assistant')
    expect(map.get('msg2')).toHaveLength(1)
  })

  it('returns an empty map without querying when no trigger ids are given', async () => {
    const client = fakeSupabase({})
    const map = await loadAgentTurnsForTriggers(client as never, 'conv1', [])
    expect(map.size).toBe(0)
    expect(client.from).not.toHaveBeenCalled()
  })
})
