import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/caye-operator-messages', () => ({ persistAgentTurns: vi.fn() }))
vi.mock('@/lib/operator-identity', () => ({ resolveFounderOperator: vi.fn() }))
vi.mock('@/lib/caye-direct-threads', () => ({
  getThread: vi.fn(),
  setThreadStatus: vi.fn(),
  touchThread: vi.fn(),
  linkInsertedMessagesToThreads: vi.fn(),
}))
vi.mock('@/lib/caye-direct-threads-summarize', () => ({
  maybeGenerateThreadTitle: vi.fn(),
  maybeRefreshThreadSummary: vi.fn(),
}))

import { persistConversationalVoiceTurn } from './conversational-fast-path'
import { getThread, touchThread, linkInsertedMessagesToThreads } from '@/lib/caye-direct-threads'
import { persistAgentTurns } from '@/lib/caye-operator-messages'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { maybeGenerateThreadTitle, maybeRefreshThreadSummary } from '@/lib/caye-direct-threads-summarize'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The voice route replies before this write finishes, which is only safe if
 * two quick fast-path turns on one thread cannot land out of order. The
 * first write here is deliberately slower than the second: without the
 * per-thread queue, "thanks" would be written before "Hey Caye" and the
 * transcript would read backwards.
 */
describe('fast-path persistence ordering', () => {
  let written: string[]

  beforeEach(() => {
    written = []
    vi.mocked(resolveFounderOperator).mockResolvedValue({ id: 1, name: 'Founder', role: 'founder' } as never)
    vi.mocked(getThread).mockResolvedValue({ id: 't-1', status: 'active' } as never)
    vi.mocked(touchThread).mockResolvedValue(undefined as never)
    vi.mocked(linkInsertedMessagesToThreads).mockResolvedValue(undefined as never)
    vi.mocked(maybeGenerateThreadTitle).mockResolvedValue(undefined as never)
    vi.mocked(maybeRefreshThreadSummary).mockResolvedValue(undefined as never)

    let call = 0
    vi.mocked(persistAgentTurns).mockImplementation((async (
      _client: unknown,
      _workspaceId: unknown,
      turns: Array<{ role: string; content: string }>
    ) => {
      // First write is the slow one.
      await sleep(call++ === 0 ? 40 : 1)
      written.push(String(turns[0].content))
      return [{ id: 'm1' }, { id: 'm2' }]
    }) as never)
  })

  it('writes two rapid turns on one thread in the order they were spoken', async () => {
    const first = persistConversationalVoiceTurn('ws-1', 't-1', 'Hey Caye', "Hey. I'm here.")
    const second = persistConversationalVoiceTurn('ws-1', 't-1', 'thanks', 'Anytime.')
    await Promise.all([first, second])
    expect(written).toEqual(['Hey Caye', 'thanks'])
  })

  it('does not wedge later turns when one write fails', async () => {
    vi.mocked(getThread).mockResolvedValueOnce(null as never)
    await expect(persistConversationalVoiceTurn('ws-1', 't-1', 'Hey Caye', 'Hey.')).rejects.toThrow('Thread not found')
    await persistConversationalVoiceTurn('ws-1', 't-1', 'thanks', 'Anytime.')
    expect(written).toEqual(['thanks'])
  })

  it('lets independent threads write concurrently', async () => {
    const started = Date.now()
    await Promise.all([
      persistConversationalVoiceTurn('ws-1', 't-1', 'Hey Caye', 'Hey.'),
      persistConversationalVoiceTurn('ws-1', 't-2', 'thanks', 'Anytime.'),
    ])
    // Serialized would be 40 + 1; concurrent is bounded by the slower one.
    expect(Date.now() - started).toBeLessThan(40 + 1 + 25)
    expect(written).toHaveLength(2)
  })

  it('surfaces a failed write to its own caller without rejecting the next one', async () => {
    vi.mocked(persistAgentTurns).mockRejectedValueOnce(new Error('supabase down') as never)
    await expect(persistConversationalVoiceTurn('ws-1', 't-1', 'Hey Caye', 'Hey.')).rejects.toThrow('supabase down')
    await expect(persistConversationalVoiceTurn('ws-1', 't-1', 'thanks', 'Anytime.')).resolves.toBeUndefined()
  })
})
