import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const { loggedMessagesCreate, threadsDb, updates } = vi.hoisted(() => ({
  loggedMessagesCreate: vi.fn(),
  threadsDb: new Map<string, { id: string; title: string | null; summary: string | null; summary_updated_at: string | null }>(),
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
}))

vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    // Anthropic() is only ever constructed here so loggedMessagesCreate can
    // be handed something — the fake never calls a real method on it.
  },
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updates.push({ id, patch })
          const row = threadsDb.get(id)
          if (row) Object.assign(row, patch)
          return { is: () => Promise.resolve({ data: null, error: null }) }
        },
      }),
    }),
  }),
}))

vi.mock('@/lib/caye-direct-threads', () => ({
  getThread: (_supabase: unknown, _workspaceId: string, threadId: string) =>
    Promise.resolve(threadsDb.get(threadId) ?? null),
  getThreadMessages: vi.fn(),
}))

import { maybeGenerateThreadTitle, maybeRefreshThreadSummary, parseRoutineThreadTitle } from './caye-direct-threads-summarize'
import { getThreadMessages } from './caye-direct-threads'

function textResponse(text: string) {
  return { content: [{ type: 'text', text }] }
}

function messageRow(i: number, body: string, hoursAgo = 0) {
  return {
    id: `m${i}`,
    direction: i % 2 === 0 ? 'inbound' : 'outbound',
    body,
    created_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    origin: 'dashboard' as const,
    operator_name: 'Lamar',
    operator_role: 'founder',
    wa_delivery_status: null,
    wa_delivery_error: null,
  }
}

beforeEach(() => {
  threadsDb.clear()
  updates.length = 0
  loggedMessagesCreate.mockReset()
  vi.mocked(getThreadMessages).mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('maybeGenerateThreadTitle', () => {
  it('titles a fresh thread from its first exchange, once', async () => {
    threadsDb.set('t1', { id: 't1', title: null, summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue([
      messageRow(0, 'Emily wants a 3-person golf cart tour, can we do the private rate?'),
      messageRow(1, 'Yes, approved — go ahead and offer the private rate.'),
    ] as any)
    loggedMessagesCreate.mockResolvedValue(textResponse('Emily pricing exception'))

    await maybeGenerateThreadTitle('ws-1', 't1')

    expect(loggedMessagesCreate).toHaveBeenCalledTimes(1)
    expect(updates[0].patch.title).toBe('Emily pricing exception')
  })

  it('never re-titles a thread that already has one', async () => {
    threadsDb.set('t1', { id: 't1', title: 'August bookings', summary: null, summary_updated_at: null })

    await maybeGenerateThreadTitle('ws-1', 't1')

    expect(loggedMessagesCreate).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('uses the validated routine title without calling the frontier model', async () => {
    threadsDb.set('t1', { id: 't1', title: null, summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue([messageRow(0, 'Emily wants a 3-person golf cart tour.')] as any)
    vi.stubEnv('CAYE_ROUTINE_MODEL_ENABLED', 'true')
    vi.stubEnv('CAYE_ROUTINE_MODEL_BASE_URL', 'https://routine.example/v1')
    vi.stubEnv('CAYE_ROUTINE_MODEL_API_KEY', 'routine-test-secret')
    vi.stubEnv('CAYE_ROUTINE_MODEL', 'small-model')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"title","title":"Emily golf cart tour"}' } }] }), { status: 200 })))

    await maybeGenerateThreadTitle('ws-1', 't1')

    expect(loggedMessagesCreate).not.toHaveBeenCalled()
    expect(updates[0].patch.title).toBe('Emily golf cart tour')
  })

  it('preserves the existing frontier title call when routine routing is disabled', async () => {
    threadsDb.set('t1', { id: 't1', title: null, summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue([messageRow(0, 'Emily wants a tour.')] as any)
    loggedMessagesCreate.mockResolvedValue(textResponse('Emily tour request'))
    vi.stubEnv('CAYE_ROUTINE_MODEL_ENABLED', 'false')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await maybeGenerateThreadTitle('ws-1', 't1')

    expect(fetch).not.toHaveBeenCalled()
    expect(loggedMessagesCreate).toHaveBeenCalledOnce()
    expect(updates[0].patch.title).toBe('Emily tour request')
  })

  it.each([
    ['invalid routine structure', '{"kind":"title","title":"One"}'],
    ['explicit routine escalation', '{"kind":"escalate"}'],
  ])('falls back to the existing frontier title call for %s', async (_name, content) => {
    threadsDb.set('t1', { id: 't1', title: null, summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue([messageRow(0, 'Emily wants a tour.')] as any)
    loggedMessagesCreate.mockResolvedValue(textResponse('Emily tour request'))
    vi.stubEnv('CAYE_ROUTINE_MODEL_ENABLED', 'true')
    vi.stubEnv('CAYE_ROUTINE_MODEL_BASE_URL', 'https://routine.example/v1')
    vi.stubEnv('CAYE_ROUTINE_MODEL_API_KEY', 'routine-test-secret')
    vi.stubEnv('CAYE_ROUTINE_MODEL', 'small-model')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })))

    await maybeGenerateThreadTitle('ws-1', 't1')

    expect(loggedMessagesCreate).toHaveBeenCalledOnce()
    expect(updates[0].patch.title).toBe('Emily tour request')
  })

  it('falls back to frontier when routine inference fails and logs only safe metadata', async () => {
    threadsDb.set('t1', { id: 't1', title: null, summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue([messageRow(0, 'Emily wants a tour.')] as any)
    loggedMessagesCreate.mockResolvedValue(textResponse('Emily tour request'))
    vi.stubEnv('CAYE_ROUTINE_MODEL_ENABLED', 'true')
    vi.stubEnv('CAYE_ROUTINE_MODEL_BASE_URL', 'https://routine.example/v1')
    vi.stubEnv('CAYE_ROUTINE_MODEL_API_KEY', 'routine-test-secret')
    vi.stubEnv('CAYE_ROUTINE_MODEL', 'small-model')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    await maybeGenerateThreadTitle('ws-1', 't1')

    expect(loggedMessagesCreate).toHaveBeenCalledOnce()
    expect(info).toHaveBeenCalledWith('[routine-inference]', expect.objectContaining({ workload: 'caye_direct_thread_title', actualTier: 'frontier', fallbackReason: 'routine_provider_error' }))
    expect(JSON.stringify(info.mock.calls)).not.toContain('routine-test-secret')
    expect(JSON.stringify(info.mock.calls)).not.toContain('Emily wants a tour')
  })

  it('falls back to frontier when the routine title request times out', async () => {
    threadsDb.set('t1', { id: 't1', title: null, summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue([messageRow(0, 'Emily wants a tour.')] as any)
    loggedMessagesCreate.mockResolvedValue(textResponse('Emily tour request'))
    vi.stubEnv('CAYE_ROUTINE_MODEL_ENABLED', 'true')
    vi.stubEnv('CAYE_ROUTINE_MODEL_BASE_URL', 'https://routine.example/v1')
    vi.stubEnv('CAYE_ROUTINE_MODEL_API_KEY', 'routine-test-secret')
    vi.stubEnv('CAYE_ROUTINE_MODEL', 'small-model')
    vi.stubEnv('CAYE_ROUTINE_MODEL_TIMEOUT_MS', '5')
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))))

    await maybeGenerateThreadTitle('ws-1', 't1')

    expect(loggedMessagesCreate).toHaveBeenCalledOnce()
    expect(updates[0].patch.title).toBe('Emily tour request')
  })
})

describe('parseRoutineThreadTitle', () => {
  it.each([
    '{"kind":"unknown","title":"Emily tour request"}',
    '{"kind":"title","title":"Emily tour request","extra":true}',
    '{"kind":"title","title":"Emily tour request."}',
    '{"kind":"title","title":"One"}',
  ])('rejects invalid or unknown routine title shapes', (content) => {
    expect(() => parseRoutineThreadTitle(content)).toThrow()
  })

  it('accepts only the explicit structural escalation shape', () => {
    expect(parseRoutineThreadTitle('{"kind":"escalate"}')).toEqual({ kind: 'escalate' })
    expect(() => parseRoutineThreadTitle('{"kind":"escalate","title":"ignored"}')).toThrow()
  })
})

describe('maybeRefreshThreadSummary (Test J)', () => {
  it('skips summarizing a short thread — replaying it in full is still cheaper', async () => {
    threadsDb.set('t1', { id: 't1', title: 'Deposit policy', summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => messageRow(i, `message ${i}`)) as any
    )

    await maybeRefreshThreadSummary('ws-1', 't1')

    expect(loggedMessagesCreate).not.toHaveBeenCalled()
  })

  it('condenses a long thread into a rolling summary once the threshold is crossed', async () => {
    threadsDb.set('t1', { id: 't1', title: 'Outreach performance', summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => messageRow(i, `message ${i}`)) as any
    )
    loggedMessagesCreate.mockResolvedValue(
      textResponse("We've been reviewing outreach performance this week; reply rate is up, no decisions pending.")
    )

    await maybeRefreshThreadSummary('ws-1', 't1')

    expect(loggedMessagesCreate).toHaveBeenCalledTimes(1)
    expect(updates[0].patch.summary).toContain('outreach performance')
    expect(updates[0].patch.summary_updated_at).toBeTruthy()
  })

  it('leaves the summary untouched (not a stale/wrong one) if the model call fails', async () => {
    threadsDb.set('t1', { id: 't1', title: 'Outreach performance', summary: null, summary_updated_at: null })
    vi.mocked(getThreadMessages).mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => messageRow(i, `message ${i}`)) as any
    )
    loggedMessagesCreate.mockRejectedValue(new Error('model unavailable'))

    await expect(maybeRefreshThreadSummary('ws-1', 't1')).resolves.toBeUndefined()

    expect(threadsDb.get('t1')!.summary).toBeNull()
    expect(updates).toHaveLength(0)
  })
})
