/**
 * Google compares OAuth redirect URIs byte-for-byte. Keep Gmail's callback
 * independently configurable so a site-wide canonical-host change cannot
 * silently break its Google Cloud client configuration.
 */
export function gmailOAuthRedirectUri(): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI
    || `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/gmail/callback`
}
