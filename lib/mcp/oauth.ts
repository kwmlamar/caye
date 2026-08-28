import 'server-only'

const DEFAULT_APP_ORIGIN = 'https://www.meetcaye.com'

export const MCP_OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const

function configuredOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim() || DEFAULT_APP_ORIGIN
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('NEXT_PUBLIC_APP_URL must be an HTTPS origin without credentials')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.origin
}

export function mcpResourceUrl(): string {
  return new URL('/api/mcp', configuredOrigin()).toString()
}

export function mcpProtectedResourceMetadataUrl(): string {
  return new URL('/.well-known/oauth-protected-resource/api/mcp', configuredOrigin()).toString()
}

/** The OAuth 2.1 authorization server supplied by Caye's existing Supabase Auth project. */
export function supabaseOAuthIssuer(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return new URL('/auth/v1', url).toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/** RFC 9728 metadata for the MCP protected resource. */
export function mcpProtectedResourceMetadata() {
  const issuer = supabaseOAuthIssuer()
  if (!issuer) return null
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [issuer],
    scopes_supported: MCP_OAUTH_SCOPES,
    bearer_methods_supported: ['header'],
  }
}
