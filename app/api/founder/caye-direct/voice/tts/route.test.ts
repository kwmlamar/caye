import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

import { POST } from './route'

const ENV_KEYS = ['ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY'] as const

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/voice/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/founder/caye-direct/voice/tts', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    requireFounderMock.mockReset()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  it('rejects a non-founder caller with 403 before touching any provider', async () => {
    requireFounderMock.mockResolvedValue(null)
    const res = await POST(req({ text: 'hi', provider: 'elevenlabs', workspaceId: 'ws-1' }))
    expect(res.status).toBe(403)
  })

  it('requires text, provider, and workspaceId', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(req({ text: 'hi' }))
    expect(res.status).toBe(400)
  })

  it('returns 503 rather than fabricated audio when no TTS provider is configured', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(req({ text: 'hi', provider: 'elevenlabs', workspaceId: 'ws-1' }))
    expect(res.status).toBe(503)
  })
})
