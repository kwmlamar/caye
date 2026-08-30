import 'server-only'

import { createSign } from 'node:crypto'

type ServiceAccount = {
  client_email: string
  private_key: string
  token_uri?: string
}

type TokenResponse = {
  access_token?: string
  expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

type CachedToken = { accessToken: string; expiresAtMs: number }
const cachedTokens = new Map<string, CachedToken>()

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>
    if (!parsed.client_email || !parsed.private_key) return null
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
      token_uri: parsed.token_uri,
    }
  } catch {
    return null
  }
}

/**
 * Returns a short-lived Google OAuth access token for read-only growth providers.
 * Cache entries are keyed by normalized scope set so adding Search Console cannot
 * accidentally reuse a GA4-only token.
 * Missing or malformed credentials are represented as null so callers can mark
 * the provider unavailable rather than converting an auth failure into zero data.
 */
export async function getGoogleGrowthAccessToken(scopes: string[]): Promise<string | null> {
  const normalizedScopes = Array.from(new Set(scopes)).sort()
  if (!normalizedScopes.length) return null

  const cacheKey = normalizedScopes.join(' ')
  const now = Date.now()
  const cached = cachedTokens.get(cacheKey)
  if (cached && cached.expiresAtMs - 60_000 > now) return cached.accessToken

  const account = loadServiceAccount()
  if (!account) return null

  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token'
  const issuedAt = Math.floor(now / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: cacheKey,
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  }))
  const unsigned = `${header}.${claims}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`

  try {
    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) return null
    const body = await response.json() as TokenResponse
    if (!body.access_token) return null

    const cachedToken = {
      accessToken: body.access_token,
      expiresAtMs: now + Math.max(60, body.expires_in ?? 3600) * 1000,
    }
    cachedTokens.set(cacheKey, cachedToken)
    return cachedToken.accessToken
  } catch {
    return null
  }
}

export function resetGoogleGrowthTokenCacheForTests() {
  cachedTokens.clear()
}
