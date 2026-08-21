import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

const requireFounderMock = vi.fn()
vi.mock('@/lib/founder', () => ({ requireFounder: (...args: unknown[]) => requireFounderMock(...args) }))

import { POST } from './route'

const ENV_KEYS = ['OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'DEEPGRAM_PROJECT_ID', 'ELEVENLABS_API_KEY'] as const

function req(body: unknown, authed = true): NextRequest {
  return new NextRequest('http://localhost/api/founder/caye-direct/voice/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authed ? { Authorization: 'Bearer test-token' } : {}) },
    body: JSON.stringify(body),
  })
}

describe('POST /api/founder/caye-direct/voice/session — founder-only gating (spec item 19)', () => {
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

  it('rejects a non-founder caller with 403 before doing any provider work', async () => {
    requireFounderMock.mockResolvedValue(null)
    const res = await POST(req({ workspaceId: 'ws-1' }))
    expect(res.status).toBe(403)
  })

  it('rejects a missing workspaceId with 400', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(requireFounderMock).not.toHaveBeenCalled()
  })

  it('returns 503 (not a fake session) when no voice provider is configured in this environment', async () => {
    requireFounderMock.mockResolvedValue({ id: 'founder-1' })
    const res = await POST(req({ workspaceId: 'ws-1' }))
    expect(res.status).toBe(503)
    const json = await res.json()
    expect(json.error).toMatch(/No STT provider available/)
  })
})
