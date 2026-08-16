import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/caye-direct-threads', () => ({
  getThread: vi.fn(),
  getThreadEntities: vi.fn(),
  describeEntity: vi.fn(),
}))

const selectResult = { data: [] as unknown[], error: null as { message: string } | null }
const agentTurnsMap = new Map<string, unknown[]>()

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {}
      builder.select = vi.fn(() => builder)
      builder.eq = vi.fn(() => builder)
      builder.gte = vi.fn(() => builder)
      builder.order = vi.fn(() => builder)
      builder.limit = vi.fn(() => Promise.resolve(selectResult))
      return builder
    },
  }),
}))

vi.mock('@/lib/caye-frontdesk-agent-turns', () => ({
  loadAgentTurnsForTriggers: vi.fn(async () => agentTurnsMap),
}))

import { loadFrontDeskConversationContext } from './context'

describe('loadFrontDeskConversationContext — Phase 3 persisted-turn splicing', () => {
  it('falls back to flattened reconstruction when no persisted agent turns exist (legacy behavior)', async () => {
    agentTurnsMap.clear()
    selectResult.data = [
      { id: 'm2', sender_type: 'agent', content: 'Sure, $450 total.', sent_at: '2026-08-16T11:59:00.000Z', channel_message_id: 'c2' },
      { id: 'm1', sender_type: 'customer', content: 'How much for 2 guests?', sent_at: '2026-08-16T11:58:00.000Z', channel_message_id: 'c1' },
    ]
    const { history } = await loadFrontDeskConversationContext('conv1')
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ role: 'user' })
    expect(history[1]).toMatchObject({ role: 'assistant' })
  })

  it('splices persisted agent turns in place of both the customer row and the reconstructed reply that followed it', async () => {
    agentTurnsMap.clear()
    agentTurnsMap.set('m1', [
      { id: 'a1', role: 'user', claude_format: { role: 'user', content: 'How much for 2 guests?' }, created_at: '2026-08-16T11:58:00.000Z' },
      {
        id: 'a2',
        role: 'assistant',
        claude_format: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'lookup_price', input: {} }] },
        created_at: '2026-08-16T11:58:05.000Z',
      },
      { id: 'a3', role: 'assistant', claude_format: { role: 'assistant', content: 'Sure, $450 total.' }, created_at: '2026-08-16T11:58:10.000Z' },
    ])
    selectResult.data = [
      { id: 'm2', sender_type: 'agent', content: 'Sure, $450 total.', sent_at: '2026-08-16T11:59:00.000Z', channel_message_id: 'c2' },
      { id: 'm1', sender_type: 'customer', content: 'How much for 2 guests?', sent_at: '2026-08-16T11:58:00.000Z', channel_message_id: 'c1' },
    ]
    const { history } = await loadFrontDeskConversationContext('conv1')
    // 3 persisted turns supersede both flattened rows — not 2, not 4.
    expect(history).toHaveLength(3)
    expect(history[1].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_use', name: 'lookup_price' })])
    )
  })
})
