import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { isFounderUserId } from '@/lib/founder'
import { createServerClient } from '@/lib/supabase-server'

const TOKEN_ENV = 'CAYE_MCP_FOUNDER_TOKEN'
const ACTOR_ENV = 'CAYE_MCP_FOUNDER_USER_ID'
const MIN_TOKEN_LENGTH = 32

export type McpFounderAuth = {
  founderUserId: string
}

type OAuthClaims = {
  aud?: unknown
  sub?: unknown
  client_id?: unknown
  scope?: unknown
}

function configuredSecret(): string | null {
  const value = process.env[TOKEN_ENV]?.trim()
  return value && value.length >= MIN_TOKEN_LENGTH ? value : null
}

function configuredFounderUserId(): string | null {
  const value = process.env[ACTOR_ENV]?.trim()
  return value && isFounderUserId(value) ? value : null
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Server-to-server auth for the founder MCP endpoint.
 *
 * This deliberately does not reuse browser-session auth. Both the bearer token
 * and the founder auth user id are server configuration, and the endpoint fails
 * closed when either is absent or malformed. The configured actor must already
 * be recognized by Caye's founder allowlist, so a leaked/mistyped env value cannot
 * promote an arbitrary auth user. The configured token is never returned or logged.
 */
function authenticateConfiguredFounderToken(authHeader: string | null): McpFounderAuth | null {
  const expectedToken = configuredSecret()
  const founderUserId = configuredFounderUserId()
  if (!expectedToken || !founderUserId) return null

  const prefix = 'Bearer '
  if (!authHeader?.startsWith(prefix)) return null
  const supplied = authHeader.slice(prefix.length).trim()
  if (!supplied || !constantTimeEqual(supplied, expectedToken)) return null

  return { founderUserId }
}

function hasOAuthIdentityScope(scope: unknown): boolean {
  return typeof scope === 'string' && scope.split(/\s+/).includes('openid')
}

/**
 * Resolves a verified Supabase OAuth token to Caye's canonical founder actor.
 *
 * Supabase Auth is the OAuth authorization server: getClaims verifies token
 * signature and expiry, and getUser provides the current server-confirmed user.
 * The `client_id` and `openid` checks distinguish an OAuth grant from Caye's
 * ordinary browser session token. No caller claim can choose a founder or scope.
 */
async function authenticateOAuthFounder(token: string): Promise<McpFounderAuth | null> {
  try {
    const client = createServerClient(token)
    const { data: claimsData, error: claimsError } = await client.auth.getClaims(token)
    const claims = claimsData?.claims as OAuthClaims | undefined
    if (claimsError || !claims || claims.aud !== 'authenticated' ||
      typeof claims.client_id !== 'string' || !claims.client_id || !hasOAuthIdentityScope(claims.scope) ||
      typeof claims.sub !== 'string' || !claims.sub) return null

    const { data: { user }, error: userError } = await client.auth.getUser(token)
    if (userError || !user || user.id !== claims.sub || !isFounderUserId(user.id)) return null
    return { founderUserId: user.id }
  } catch {
    return null
  }
}

/**
 * Authenticates either the existing server-to-server bearer credential or a
 * Supabase OAuth 2.1 access token. Both resolve only to a verified founder.
 */
export async function authenticateMcpFounder(authHeader: string | null): Promise<McpFounderAuth | null> {
  const serverAuth = authenticateConfiguredFounderToken(authHeader)
  if (serverAuth) return serverAuth

  const prefix = 'Bearer '
  if (!authHeader?.startsWith(prefix)) return null
  const token = authHeader.slice(prefix.length).trim()
  return token ? authenticateOAuthFounder(token) : null
}
