import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { isFounderUserId } from '@/lib/founder'

const TOKEN_ENV = 'CAYE_MCP_FOUNDER_TOKEN'
const ACTOR_ENV = 'CAYE_MCP_FOUNDER_USER_ID'
const MIN_TOKEN_LENGTH = 32

export type McpFounderAuth = {
  founderUserId: string
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
export function authenticateMcpFounder(authHeader: string | null): McpFounderAuth | null {
  const expectedToken = configuredSecret()
  const founderUserId = configuredFounderUserId()
  if (!expectedToken || !founderUserId) return null

  const prefix = 'Bearer '
  if (!authHeader?.startsWith(prefix)) return null
  const supplied = authHeader.slice(prefix.length).trim()
  if (!supplied || !constantTimeEqual(supplied, expectedToken)) return null

  return { founderUserId }
}
