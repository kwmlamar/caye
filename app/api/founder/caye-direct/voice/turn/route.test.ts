import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

const runFounderThreadTurnMock = vi.fn()
vi.mock('@/lib/caye-agent/founder-thread-turn', () => ({
  runFounderThreadTurn: (...args: unknown[]) => runFounderThreadTurnMock(...args),
}))

import { POST } from './route'

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/voice/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/founder/caye-direct/voice/turn', () => {
  beforeEach(() => {
    requireFounderMock.mockReset()
    runFounderThreadTurnMock.mockReset()
  })

  it('rejects a non-founder caller with 403 before running any turn', async () => {
    requireFounderMock.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: 'hi' }))
    expect(res.status).toBe(403)
    expect(runFounderThreadTurnMock).not.toHaveBeenCalled()
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
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: 'What is going on with Kenneth?', sessionId: 'voice_1' }))
    expect(res.status).toBe(200)
    expect(runFounderThreadTurnMock).toHaveBeenCalledWith('ws-1', 't-1', 'What is going on with Kenneth?')
    expect(await res.json()).toEqual({ replyText: 'Got it.', threadId: 't-1' })
  })

  it('maps a "Thread not found" error to 404', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    runFounderThreadTurnMock.mockRejectedValue(new Error('Thread not found'))
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 'missing', message: 'hi' }))
    expect(res.status).toBe(404)
  })

  it('maps any other agent failure to 500', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    runFounderThreadTurnMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req({ workspaceId: 'ws-1', threadId: 't-1', message: 'hi' }))
    expect(res.status).toBe(500)
  })
})
