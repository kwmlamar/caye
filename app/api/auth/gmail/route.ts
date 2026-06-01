import { NextRequest, NextResponse } from 'next/server'

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
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/gmail/callback`
  const source = req.nextUrl.searchParams.get('source') || 'desktop'

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
