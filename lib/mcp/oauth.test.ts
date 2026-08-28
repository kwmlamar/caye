import { afterEach, describe, expect, it } from 'vitest'

import {
  MCP_OAUTH_SCOPES,
  mcpProtectedResourceMetadata,
  mcpProtectedResourceMetadataUrl,
  mcpResourceUrl,
  supabaseOAuthIssuer,
} from './oauth'

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL
const ORIGINAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL
  if (ORIGINAL_SUPABASE_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL
})

describe('MCP OAuth resource metadata', () => {
  it('advertises the Supabase OAuth authority, secure resource URL, and offline refresh scope', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://caye.example/path?untrusted=value'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'

    expect(mcpResourceUrl()).toBe('https://caye.example/api/mcp')
    expect(mcpProtectedResourceMetadataUrl()).toBe('https://caye.example/.well-known/oauth-protected-resource/api/mcp')
    expect(mcpProtectedResourceMetadata()).toEqual({
      resource: 'https://caye.example/api/mcp',
      authorization_servers: ['https://project.supabase.co/auth/v1'],
      scopes_supported: MCP_OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
    })
  })

  it('does not advertise OAuth if the configured authorization-server URL is malformed', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://project.supabase.co'
    expect(supabaseOAuthIssuer()).toBeNull()
    expect(mcpProtectedResourceMetadata()).toBeNull()
  })
})
