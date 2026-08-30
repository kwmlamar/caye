import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { getGoogleGrowthAccessToken, resetGoogleGrowthTokenCacheForTests } from './google-auth'

const originalCredentials = process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON

function restoreCredentials() {
  if (originalCredentials === undefined) delete process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON
  else process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON = originalCredentials
}

describe('Google growth auth diagnostics', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetGoogleGrowthTokenCacheForTests()
    delete process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON
  })

  afterEach(() => {
    restoreCredentials()
    vi.unstubAllGlobals()
  })

  it('distinguishes malformed credential JSON without logging the raw secret', async () => {
    const rawSecret = '{definitely-not-json'
    process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON = rawSecret
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await getGoogleGrowthAccessToken(['scope-a'])).toBeNull()
    expect(warn).toHaveBeenCalledWith('[growth-google-auth]', 'credentials_malformed_json', {})
    expect(JSON.stringify(warn.mock.calls)).not.toContain(rawSecret)
  })

  it('reports an invalid private key before any token request', async () => {
    process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: 'growth@example.iam.gserviceaccount.com',
      private_key: 'not-a-private-key',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await getGoogleGrowthAccessToken(['scope-a'])).toBeNull()
    expect(warn).toHaveBeenCalledWith('[growth-google-auth]', 'private_key_invalid', {})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logs only bounded Google error metadata when the token endpoint rejects a JWT', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const clientEmail = 'growth@example.iam.gserviceaccount.com'
    process.env.GOOGLE_GROWTH_SERVICE_ACCOUNT_JSON = JSON.stringify({
      client_email: clientEmail,
      private_key: privateKeyPem,
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'sensitive provider detail that must not be logged',
    }), { status: 400, headers: { 'content-type': 'application/json' } })))

    expect(await getGoogleGrowthAccessToken(['scope-a'])).toBeNull()
    expect(warn).toHaveBeenCalledWith('[growth-google-auth]', 'token_rejected', {
      status: 400,
      google_error: 'invalid_grant',
    })

    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain(clientEmail)
    expect(logged).not.toContain(privateKeyPem)
    expect(logged).not.toContain('sensitive provider detail')
  })
})
