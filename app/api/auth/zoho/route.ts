import { NextRequest, NextResponse } from 'next/server'

const ZOHO_AUTH_URL = 'https://accounts.zoho.com/oauth/v2/auth'
const SCOPES = 'ZohoMail.messages.ALL,ZohoMail.accounts.READ,ZohoMail.folders.READ,ZohoCalendar.event.ALL,ZohoCalendar.calendar.READ'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })
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
