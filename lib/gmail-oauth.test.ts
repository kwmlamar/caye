import { afterEach, describe, expect, it } from 'vitest'
import { gmailOAuthRedirectUri } from './gmail-oauth'

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL
const originalGoogleRedirect = process.env.GOOGLE_OAUTH_REDIRECT_URI

afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
  if (originalGoogleRedirect === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI
  else process.env.GOOGLE_OAUTH_REDIRECT_URI = originalGoogleRedirect
})

describe('gmailOAuthRedirectUri', () => {
  it('uses Gmail’s explicit callback when configured', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.meetcaye.com'
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://meetcaye.com/api/auth/gmail/callback'

    expect(gmailOAuthRedirectUri()).toBe('https://meetcaye.com/api/auth/gmail/callback')
  })

  it('falls back to the app URL for existing deployments', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.test'
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI

    expect(gmailOAuthRedirectUri()).toBe('https://example.test/api/auth/gmail/callback')
  })
})
