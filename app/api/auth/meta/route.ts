import { NextRequest, NextResponse } from 'next/server'

const META_AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth'
// pages_messaging — send/receive messages
// pages_read_engagement — read page info
// pages_manage_metadata — subscribe to webhook events
const SCOPES = 'pages_messaging,pages_read_engagement,pages_manage_metadata'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  const channel = req.nextUrl.searchParams.get('channel') || 'messenger'
  if (!workspaceId) {
    return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })
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
