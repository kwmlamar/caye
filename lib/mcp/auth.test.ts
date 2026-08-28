import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isFounderUserId: vi.fn((value: string) => value === 'founder-user-id'),
  createServerClient: vi.fn(),
}))
vi.mock('@/lib/founder', () => ({ isFounderUserId: mocks.isFounderUserId }))
vi.mock('@/lib/supabase-server', () => ({ createServerClient: mocks.createServerClient }))

import { authenticateMcpFounder } from './auth'

const ORIGINAL_TOKEN = process.env.CAYE_MCP_FOUNDER_TOKEN
const ORIGINAL_USER = process.env.CAYE_MCP_FOUNDER_USER_ID
const TOKEN = 'correct-secret-that-is-definitely-long-enough'

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.CAYE_MCP_FOUNDER_TOKEN
  else process.env.CAYE_MCP_FOUNDER_TOKEN = ORIGINAL_TOKEN
  if (ORIGINAL_USER === undefined) delete process.env.CAYE_MCP_FOUNDER_USER_ID
  else process.env.CAYE_MCP_FOUNDER_USER_ID = ORIGINAL_USER
  vi.clearAllMocks()
})

function oauthClient(overrides?: { claims?: unknown; claimsError?: unknown; user?: unknown; userError?: unknown }) {
  return {
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: { claims: overrides?.claims ?? { aud: 'authenticated', sub: 'founder-user-id', client_id: 'chatgpt-client', scope: 'openid offline_access' } },
        error: overrides?.claimsError ?? null,
      }),
      getUser: vi.fn().mockResolvedValue({
        data: { user: overrides?.user === undefined ? { id: 'founder-user-id' } : overrides.user },
        error: overrides?.userError ?? null,
      }),
    },
  }
}

describe('MCP founder authentication', () => {
  it('fails closed when server configuration is missing and an OAuth token is invalid', async () => {
    delete process.env.CAYE_MCP_FOUNDER_TOKEN
    delete process.env.CAYE_MCP_FOUNDER_USER_ID
    mocks.createServerClient.mockReturnValue(oauthClient({ claimsError: new Error('invalid JWT') }))
    await expect(authenticateMcpFounder('Bearer anything')).resolves.toBeNull()
  })

  it('fails closed on weak server tokens and non-founder configured identities', async () => {
    mocks.createServerClient.mockReturnValue(oauthClient({ claimsError: new Error('invalid JWT') }))
    process.env.CAYE_MCP_FOUNDER_TOKEN = 'too-short'
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'founder-user-id'
    await expect(authenticateMcpFounder('Bearer too-short')).resolves.toBeNull()

    process.env.CAYE_MCP_FOUNDER_TOKEN = TOKEN
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'not-a-founder'
    await expect(authenticateMcpFounder(`Bearer ${TOKEN}`)).resolves.toBeNull()
  })

  it('preserves the configured server-to-server bearer path', async () => {
    process.env.CAYE_MCP_FOUNDER_TOKEN = TOKEN
    process.env.CAYE_MCP_FOUNDER_USER_ID = 'founder-user-id'
    await expect(authenticateMcpFounder(`Bearer ${TOKEN}`)).resolves.toEqual({ founderUserId: 'founder-user-id' })
    expect(mocks.createServerClient).not.toHaveBeenCalled()
  })

  it('maps a verified scoped OAuth token to the server-confirmed founder, never a configured founder id', async () => {
    delete process.env.CAYE_MCP_FOUNDER_TOKEN
    delete process.env.CAYE_MCP_FOUNDER_USER_ID
    mocks.createServerClient.mockReturnValue(oauthClient())

    await expect(authenticateMcpFounder('Bearer supabase-oauth-token')).resolves.toEqual({ founderUserId: 'founder-user-id' })
    expect(mocks.createServerClient).toHaveBeenCalledWith('supabase-oauth-token')
    const auth = mocks.createServerClient.mock.results[0]?.value.auth
    expect(auth.getClaims).toHaveBeenCalledWith('supabase-oauth-token')
    expect(auth.getUser).toHaveBeenCalledWith('supabase-oauth-token')
  })

  it.each([
    ['expired token', { claimsError: new Error('JWT expired') }],
    ['wrong audience', { claims: { aud: 'other', sub: 'founder-user-id', client_id: 'chatgpt-client', scope: 'openid offline_access' } }],
    ['missing OAuth client identity', { claims: { aud: 'authenticated', sub: 'founder-user-id', scope: 'openid offline_access' } }],
    ['unscoped token', { claims: { aud: 'authenticated', sub: 'founder-user-id', client_id: 'chatgpt-client', scope: 'profile' } }],
    ['non-founder user', { user: { id: 'customer-user-id' }, claims: { aud: 'authenticated', sub: 'customer-user-id', client_id: 'chatgpt-client', scope: 'openid offline_access' } }],
    ['spoofed subject', { user: { id: 'founder-user-id' }, claims: { aud: 'authenticated', sub: 'spoofed-founder-id', client_id: 'chatgpt-client', scope: 'openid offline_access' } }],
  ])('fails closed for %s', async (_caseName, input) => {
    delete process.env.CAYE_MCP_FOUNDER_TOKEN
    delete process.env.CAYE_MCP_FOUNDER_USER_ID
    mocks.createServerClient.mockReturnValue(oauthClient(input))
    await expect(authenticateMcpFounder('Bearer bad-or-untrusted-token')).resolves.toBeNull()
  })
})
