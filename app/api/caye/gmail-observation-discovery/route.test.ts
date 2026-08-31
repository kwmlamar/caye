import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/gmail-token', () => ({ getGmailContext: vi.fn() }))
vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate: vi.fn() }))

import { GET } from './route'

describe('GET /api/caye/gmail-observation-discovery', () => {
  it('rejects a request without the cron secret', async () => {
    process.env.CRON_SECRET = 'cron-secret'
    const res = await GET(new NextRequest('https://www.meetcaye.com/api/caye/gmail-observation-discovery'))
    expect(res.status).toBe(401)
  })
})
