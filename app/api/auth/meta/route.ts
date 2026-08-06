import { NextRequest, NextResponse } from 'next/server'
import { verifyConnectToken, isConnectChannel } from '@/lib/channels/connect-token'

const META_AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth'
// pages_messaging — send/receive messages
// pages_read_engagement — read page info
// pages_manage_metadata — subscribe to webhook events
const SCOPES = 'pages_messaging,pages_read_engagement,pages_manage_metadata'

export async function GET(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.meetcaye.com'
  const channel = req.nextUrl.searchParams.get('channel') || 'messenger'

  // The token is bound to its channel, so an Instagram link can't be
  // replayed to grant Messenger. See lib/channels/connect-token.
  if (!isConnectChannel(channel)) {
    return NextResponse.redirect(`${appUrl}/connect?link_error=malformed`)
  }
  const verified = verifyConnectToken(req.nextUrl.searchParams.get('t'), channel)
  if (!verified.ok) {
    return NextResponse.redirect(`${appUrl}/connect?link_error=${verified.reason}`)
  }
  const workspaceId = verified.workspaceId

  // See the gmail route. Meta's own OAuth is likelier to tolerate an
  // in-app browser than Google's, but the escape hatch is harmless when
  // unnecessary and a dead end is not.
  if (!req.nextUrl.searchParams.get('ext')) {
    const { isEmbeddedBrowser } = await import('@/lib/channels/embedded-browser')
    if (isEmbeddedBrowser(req.headers.get('user-agent'))) {
      const t = encodeURIComponent(req.nextUrl.searchParams.get('t') ?? '')
      return NextResponse.redirect(`${appUrl}/connect/open?channel=${channel}&t=${t}`)
    }
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/meta/callback`

  // Request appropriate scopes depending on the channel being connected
  const scopes = channel === 'instagram'
    ? 'instagram_basic,instagram_manage_messages,pages_read_engagement,pages_show_list'
    : channel === 'whatsapp'
    ? 'whatsapp_business_management,whatsapp_business_messaging,pages_read_engagement,pages_show_list'
    : 'pages_messaging,pages_read_engagement,pages_manage_metadata'

  const source = req.nextUrl.searchParams.get('source') || 'desktop'

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    redirect_uri: redirectUri,
    scope: scopes,
    response_type: 'code',
    state: `${workspaceId}:${channel}:${source}`,
  })

  return NextResponse.redirect(`${META_AUTH_URL}?${params.toString()}`)
}
