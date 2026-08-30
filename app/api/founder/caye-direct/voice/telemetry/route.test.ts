import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

import { POST } from './route'

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/voice/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  })
}

function loggedPayload(log: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const line = (log.mock.calls as unknown[][]).find((c) => c[0] === '[caye-voice] client_timeline')
  expect(line).toBeDefined()
  return JSON.parse(line![1] as string)
}

describe('POST /api/founder/caye-direct/voice/telemetry', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    requireFounderMock.mockReset()
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => log.mockRestore())

  it('rejects a non-founder caller', async () => {
    requireFounderMock.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: 'ws-1', sessionId: 'voice_1', marks: [] }))
    expect(res.status).toBe(403)
    expect(log).not.toHaveBeenCalledWith('[caye-voice] client_timeline', expect.anything())
  })

  it('requires workspaceId and sessionId', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(req({ sessionId: 'voice_1' }))
    expect(res.status).toBe(400)
  })

  it('logs the browser half of the turn timeline', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(
      req({
        workspaceId: 'ws-1',
        sessionId: 'voice_1',
        backend: 'openai_api',
        metrics: { speechEndToFirstAudioMs: 980, requestRoundTripMs: 500, replyToFirstAudioMs: null },
        marks: [
          { stage: 'speech_end', atMs: 1400 },
          { stage: 'first_audible_audio', atMs: 2380 },
        ],
      })
    )
    expect(res.status).toBe(200)
    const payload = loggedPayload(log)
    expect(payload).toMatchObject({ workspaceId: 'ws-1', sessionId: 'voice_1', backend: 'openai_api' })
    expect(payload.metrics).toEqual({ speechEndToFirstAudioMs: 980, requestRoundTripMs: 500, replyToFirstAudioMs: null })
    expect(payload.marks).toEqual([
      { stage: 'speech_end', atMs: 1400 },
      { stage: 'first_audible_audio', atMs: 2380 },
    ])
  })

  /**
   * The route re-shapes rather than echoes, so a client that sent anything
   * other than timings could not get it into the logs. This is the guard on
   * that, not a claim about what the real client sends.
   */
  it('drops non-numeric fields instead of echoing whatever the body contained', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(
      req({
        workspaceId: 'ws-1',
        sessionId: 'voice_1',
        metrics: { speechEndToFirstAudioMs: 980, transcript: 'send Mrs. Max the invoice' },
        marks: [
          { stage: 'speech_end', atMs: 10, transcript: 'send Mrs. Max the invoice' },
          { stage: 'bogus', atMs: 'not-a-number' },
          'garbage',
        ],
      })
    )
    expect(res.status).toBe(200)
    const raw = JSON.stringify(loggedPayload(log))
    expect(raw).not.toContain('Mrs. Max')
    expect(raw).not.toContain('transcript')
    const payload = loggedPayload(log)
    expect(payload.metrics).toEqual({ speechEndToFirstAudioMs: 980 })
    expect(payload.marks).toEqual([{ stage: 'speech_end', atMs: 10 }])
  })

  it('caps how much one turn can write to the logs', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const marks = Array.from({ length: 500 }, (_, i) => ({ stage: 'speech_end', atMs: i }))
    const res = await POST(req({ workspaceId: 'ws-1', sessionId: 'voice_1', marks }))
    expect(res.status).toBe(200)
    expect((loggedPayload(log).marks as unknown[]).length).toBe(64)
  })

  it('tolerates a malformed body', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(
      new NextRequest('http://localhost/api/founder/caye-direct/voice/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
    )
    expect(res.status).toBe(400)
  })
})
