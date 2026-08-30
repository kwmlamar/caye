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

function warnAuthFailure(code: string, metadata?: Record<string, string | number>) {
  // Never log the service-account JSON, client email, private key, JWT, access token,
  // or Google's free-form error_description. Only bounded diagnostic codes belong here.
  console.warn('[growth-google-auth]', code, metadata ?? {})
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON
  if (!raw) {
    warnAuthFailure('credentials_missing')
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>
    if (!parsed.client_email || !parsed.private_key) {
      warnAuthFailure('credentials_incomplete')
      return null
    }
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
      token_uri: parsed.token_uri,
    }
  } catch {
    warnAuthFailure('credentials_malformed_json')
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

  let assertion: string
  try {
    const signer = createSign('RSA-SHA256')
    signer.update(unsigned)
    signer.end()
    assertion = `${unsigned}.${signer.sign(account.private_key).toString('base64url')}`
  } catch {
    warnAuthFailure('private_key_invalid')
    return null
  }

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

    if (!response.ok) {
      let googleError = 'unknown'
      try {
        const body = await response.clone().json() as TokenResponse
        if (body.error && /^[a-z0-9_.-]{1,64}$/i.test(body.error)) googleError = body.error
      } catch {
        // Response bodies can be empty/non-JSON. The HTTP status still gives us a safe signal.
      }
      warnAuthFailure('token_rejected', { status: response.status, google_error: googleError })
      return null
    }

    const body = await response.json() as TokenResponse
    if (!body.access_token) {
      warnAuthFailure('token_missing_access_token')
      return null
    }

    const cachedToken = {
      accessToken: body.access_token,
      expiresAtMs: now + Math.max(60, body.expires_in ?? 3600) * 1000,
    }
    cachedTokens.set(cacheKey, cachedToken)
    return cachedToken.accessToken
  } catch (error) {
    warnAuthFailure('token_request_failed', { error_name: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}

export function resetGoogleGrowthTokenCacheForTests() {
  cachedTokens.clear()
}
