import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mcpProtectedResourceMetadata: vi.fn() }))
vi.mock('@/lib/mcp/oauth', () => ({ mcpProtectedResourceMetadata: mocks.mcpProtectedResourceMetadata }))

import { GET } from './route'

describe('MCP OAuth protected-resource discovery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('publishes standards metadata including offline refresh support', async () => {
    mocks.mcpProtectedResourceMetadata.mockReturnValue({
      resource: 'https://www.meetcaye.com/api/mcp',
      authorization_servers: ['https://project.supabase.co/auth/v1'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      bearer_methods_supported: ['header'],
    })

    const res = GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('max-age=300')
    expect(await res.json()).toMatchObject({
      authorization_servers: ['https://project.supabase.co/auth/v1'],
      scopes_supported: expect.arrayContaining(['offline_access']),
    })
  })

  it('fails closed when OAuth discovery cannot name a configured authorization server', async () => {
    mocks.mcpProtectedResourceMetadata.mockReturnValue(null)
    const res = GET()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'OAuth is not configured' })
  })
})
