import { NextRequest, NextResponse } from 'next/server'
import { verifyConnectToken } from '@/lib/channels/connect-token'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
// Scopes:
//  - gmail.readonly — list/get inbound messages
//  - gmail.send     — send Caye's outbound replies as the connected user
//  - userinfo.email — confirm which Gmail address was connected
// gmail.modify is intentionally NOT requested. We don't mark Gmail-side
// state (read flags / labels). Dedup happens by channel_message_id in
// unified_messages. If a customer needs Gmail-side read state, that's
// a follow-on scope expansion.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

export async function GET(req: NextRequest) {
  // Signed token rather than a bare workspace id: Caye texts these links,
  // so they live in forwardable messages. See lib/channels/connect-token.
  const verified = verifyConnectToken(req.nextUrl.searchParams.get('t'), 'gmail')
  if (!verified.ok) {
    // A JSON 400 is useless to someone who just tapped a link in WhatsApp.
    // Send them somewhere that can say "ask Caye for a fresh one".
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.meetcaye.com'
    return NextResponse.redirect(`${appUrl}/connect?link_error=${verified.reason}`)
  }
  const workspaceId = verified.workspaceId
  const source = req.nextUrl.searchParams.get('source') || 'desktop'

  // Google refuses OAuth inside embedded WebViews, which is what a tap
  // from WhatsApp opens on Android. Divert those to an interstitial that
  // can escape to a real browser; everyone else goes straight through.
  // Preserve `source` across that handoff so a WhatsApp-originated connect
  // returns to /connect/done instead of leaking into the authenticated dashboard.
  // `ext=1` is set by that page and prevents a loop.
  if (!req.nextUrl.searchParams.get('ext')) {
    const { isEmbeddedBrowser } = await import('@/lib/channels/embedded-browser')
    if (isEmbeddedBrowser(req.headers.get('user-agent'))) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.meetcaye.com'
      const t = encodeURIComponent(req.nextUrl.searchParams.get('t') ?? '')
      const sourceParam = encodeURIComponent(source)
      return NextResponse.redirect(`${appUrl}/connect/open?channel=gmail&t=${t}&source=${sourceParam}`)
    }
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/gmail/callback`

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.GOOGLE_CLIENT_ID!,
    scope: SCOPES,
    redirect_uri: redirectUri,
    // Offline access + force consent so we always receive a refresh_token.
    // Google only returns refresh_token on first consent unless prompt=consent.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: `${workspaceId}:${source}`,
  })

  return NextResponse.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`)
}
