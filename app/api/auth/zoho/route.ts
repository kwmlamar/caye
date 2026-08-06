import { NextRequest, NextResponse } from 'next/server'
import { verifyConnectToken } from '@/lib/channels/connect-token'

const ZOHO_AUTH_URL = 'https://accounts.zoho.com/oauth/v2/auth'
const SCOPES = 'ZohoMail.messages.ALL,ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoCalendar.event.ALL,ZohoCalendar.calendar.READ'

export async function GET(req: NextRequest) {
  // Signed token rather than a bare workspace id — see the gmail route
  // and lib/channels/connect-token for why.
  const verified = verifyConnectToken(req.nextUrl.searchParams.get('t'), 'zoho')
  if (!verified.ok) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.meetcaye.com'
    return NextResponse.redirect(`${appUrl}/connect?link_error=${verified.reason}`)
  }
  const workspaceId = verified.workspaceId

  // See the gmail route — embedded WebViews get an escape hatch first.
  if (!req.nextUrl.searchParams.get('ext')) {
    const { isEmbeddedBrowser } = await import('@/lib/channels/embedded-browser')
    if (isEmbeddedBrowser(req.headers.get('user-agent'))) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.meetcaye.com'
      const t = encodeURIComponent(req.nextUrl.searchParams.get('t') ?? '')
      return NextResponse.redirect(`${appUrl}/connect/open?channel=zoho&t=${t}`)
    }
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/zoho/callback`

  const source = req.nextUrl.searchParams.get('source') || 'desktop'

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID!,
    scope: SCOPES,
    redirect_uri: redirectUri,
    access_type: 'offline',
    // Force the consent dialog every time. Zoho only issues a new refresh_token
    // when the user explicitly consents — otherwise reconnects return only an
    // access_token and the stored refresh_token gets clobbered.
    prompt: 'consent',
    state: `${workspaceId}:${source}`,
  })

  return NextResponse.redirect(`${ZOHO_AUTH_URL}?${params.toString()}`)
}
