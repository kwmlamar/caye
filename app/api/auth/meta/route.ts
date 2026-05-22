import { NextRequest, NextResponse } from 'next/server'

const META_AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth'
// pages_messaging — send/receive messages
// pages_read_engagement — read page info
// pages_manage_metadata — subscribe to webhook events
const SCOPES = 'pages_messaging,pages_read_engagement,pages_manage_metadata'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/meta/callback`

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: 'code',
    state: workspaceId,
  })

  return NextResponse.redirect(`${META_AUTH_URL}?${params.toString()}`)
}
