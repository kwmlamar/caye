import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

const runFounderThreadTurnMock = vi.fn()
vi.mock('@/lib/caye-agent/founder-thread-turn', () => ({
  runFounderThreadTurn: (...args: unknown[]) => runFounderThreadTurnMock(...args),
}))

// The fast path's REAL matcher is exercised (that is the behavior under
// test); only its database write is mocked, so a fast-path turn can be
// asserted without touching Supabase.
const persistConversationalVoiceTurnMock = vi.fn()
vi.mock('@/lib/caye-voice/conversational-fast-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/caye-voice/conversational-fast-path')>()
  return {
    conversationalVoiceReply: actual.conversationalVoiceReply,
    persistConversationalVoiceTurn: (...args: unknown[]) => persistConversationalVoiceTurnMock(...args),
  }
})

// #283 gave the route a thread-scope lookup before the turn runs, so a
// visible thread whose active workspace differs from the dashboard's
// selection is not misreported as "Thread not found". None of that is the
// behavior under test here, but all of it runs first -- so it is stubbed
// rather than reached, and `createServiceClient` never builds a real client.
const getFounderThreadByIdMock = vi.fn()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/caye-direct-threads', () => ({
  getFounderThreadById: (...args: unknown[]) => getFounderThreadByIdMock(...args),
  setThreadActiveWorkspace: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/caye-direct-thread-scope', () => ({
  // null = no authoritative override, so the turn uses the requested
  // workspace. That is the ordinary case and what these tests assert on.
  resolveAuthoritativeThreadWorkspace: vi.fn().mockResolvedValue(null),
}))

// next/server's after() defers to the platform; in a unit test it should
// just run the callback so the deferred write is still observable.
const afterCallbacks: Array<() => unknown> = []
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (cb: () => unknown) => { afterCallbacks.push(cb) } }
})

import { POST } from './route'

/** An utterance the fast path deliberately refuses — needs real workspace state. */
const OPERATIONAL = 'What is going on with Kenneth?'

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/voice/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  })
}

async function drainAfter(): Promise<void> {
  const pending = afterCallbacks.splice(0)
  for (const cb of pending) await cb()
}

describe('POST /api/founder/caye-direct/voice/turn', () => {
  beforeEach(() => {
    requireFounderMock.mockReset()
    runFounderThreadTurnMock.mockReset()
    persistConversationalVoiceTurnMock.mockReset()
    persistConversationalVoiceTurnMock.mockResolvedValue(undefined)
    getFounderThreadByIdMock.mockReset()
    getFounderThreadByIdMock.mockResolvedValue({ active_workspace_id: 'ws-1' })
    afterCallbacks.length = 0
  })

  it('rejects a non-founder caller with 403 before running any turn', async () => {
    requireFounderMock.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: OPERATIONAL }))
    expect(res.status).toBe(403)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
    expect(persistConversationalVoiceTurnMock).not.toHaveBeenCalled()
  })

  it('requires workspaceId, threadId, and message', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(req({ workspaceId: 'ws-1' }))
    expect(res.status).toBe(400)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
  })

  it('runs the SAME shared turn helper the text composer uses, with the transcript as `message`', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    runFounderThreadTurnMock.mockResolvedValue({ replyText: 'Got it.', threadId: 't-1' })
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: OPERATIONAL, sessionId: 'voice_1' }))
    expect(res.status).toBe(200)
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 't-1', OPERATIONAL, {
      requestedMode: 'auto',
      founderUserId: 'founder-1',
      responseStyle: 'voice',
    })
    expect(await res.json()).toEqual({
      replyText: 'Got it.',
      threadId: 't-1',
      activeWorkspaceId: 'ws-1',
      // No authoritative thread workspace resolved, so the turn ran in the
      // workspace the caller was looking at -- and the response says so
      // rather than leaving the caller to assume.
      workspaceContextSource: 'dashboard',
    })
  })

  it('tells the turn helper this reply will be spoken, so it is kept short and title work stops blocking', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    runFounderThreadTurnMock.mockResolvedValue({ replyText: 'Got it.', threadId: 't-1' })
    await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: OPERATIONAL }))
    expect(runFounderThreadTurnMock.mock.calls[0][3]).toMatchObject({ responseStyle: 'voice' })
  })

  it('answers a pure conversational turn WITHOUT waiting for the database write', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    // A write that never settles: if the route awaited persistence, this
    // request could not resolve at all. That is exactly the regression this
    // guards — the reply must not be gated on writing it down.
    persistConversationalVoiceTurnMock.mockReturnValue(new Promise(() => {}))

    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: 'Hey Caye', sessionId: 'voice_1' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      replyText: "Hey. I'm here. What's up?",
      threadId: 't-1',
      backend: 'voice_fast_path',
      // Where it was actually written -- the thread's active workspace, not
      // the dashboard's incidental selection.
      activeWorkspaceId: 'ws-1',
    })
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
  })

  it('still persists the fast-path exchange, after the reply has gone out', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: 'thanks' }))
    expect(res.status).toBe(200)

    // Nothing written yet — the write was handed to after().
    expect(persistConversationalVoiceTurnMock).not.toHaveBeenCalled()
    await drainAfter()
    expect(persistConversationalVoiceTurnMock).toHaveBeenCalledWith('ws-1', 't-1', 'thanks', 'Anytime.')
  })

  it('does not fail the turn when the deferred fast-path write throws', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    persistConversationalVoiceTurnMock.mockRejectedValue(new Error('supabase down'))
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: 'thanks' }))
    expect(res.status).toBe(200)
    await expect(drainAfter()).resolves.toBeUndefined()
  })

  it('maps a "Thread not found" error to 404', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    runFounderThreadTurnMock.mockRejectedValue(new Error('Thread not found'))
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 'missing', message: OPERATIONAL }))
    expect(res.status).toBe(404)
  })

  it('404s on a thread that does not exist, without running a turn', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    getFounderThreadByIdMock.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 'missing', message: OPERATIONAL }))
    expect(res.status).toBe(404)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
  })

  it('maps any other agent failure to 500', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    runFounderThreadTurnMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: OPERATIONAL }))
    expect(res.status).toBe(500)
  })
})
