import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const rawState = searchParams.get('state') || ''
  const googleError = searchParams.get('error')

  const [workspaceId, sourceVal] = rawState.split(':')
  const isMobile = sourceVal === 'mobile'

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const mobileUrl = `${appUrl}/m/${workspaceId}`
  // 'founder' = connected from Caye Command's Channels card — send them
  // back there instead of a settings tab they never navigated from.
  const desktopUrl = sourceVal === 'founder'
    ? `${appUrl}/dashboard/${workspaceId}`
    : `${appUrl}/dashboard/${workspaceId}/settings?tab=channels`
  const desktopSep = desktopUrl.includes('?') ? '&' : '?'

  const ok = (param: string) => isMobile ? mobileUrl : `${desktopUrl}${desktopSep}${param}`
  const fail = (param: string) => isMobile ? mobileUrl : `${desktopUrl}${desktopSep}${param}`

  if (googleError || !code || !workspaceId) {
    console.error('[gmail/callback] Access denied or missing params:', { googleError, code: !!code, workspaceId })
    return NextResponse.redirect(fail('gmail_error=access_denied'))
  }

  const redirectUri = `${appUrl}/api/auth/gmail/callback`

  // Exchange authorization code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
    }).toString(),
  })

  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) {
    console.error('[gmail/callback] Token exchange failed:', tokenData)
    return NextResponse.redirect(fail('gmail_error=token_exchange'))
  }

  const { access_token, refresh_token, expires_in } = tokenData
  const tokenExpiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString()

  // Fetch the user's email address from Google's userinfo endpoint.
  const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  const userinfo = await userinfoRes.json() as { email?: string; id?: string }

  const gmailAddress = (userinfo.email || '').toLowerCase()
  const googleUserId = userinfo.id || gmailAddress

  if (!gmailAddress) {
    console.error('[gmail/callback] No email returned from userinfo:', userinfo)
    return NextResponse.redirect(fail('gmail_error=account_fetch'))
  }

  const supabase = createServiceClient()

  // Deactivate any other Gmail accounts for this workspace that aren't this one.
  // (Same shape as the Zoho callback — one active Gmail per workspace.)
  await supabase
    .from('connected_accounts')
    .update({ is_active: false, status: 'inactive', needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'gmail')
    .neq('channel_account_id', googleUserId)

  // Google returns refresh_token only when prompt=consent + access_type=offline
  // on first consent. On reconsent without revoke it may be absent — preserve
  // the existing stored value rather than nulling it.
  let refreshTokenToStore: string | null = refresh_token || null
  if (!refreshTokenToStore) {
    const { data: existing } = await supabase
      .from('connected_accounts')
      .select('refresh_token')
      .eq('channel_type', 'gmail')
      .eq('channel_account_id', googleUserId)
      .maybeSingle()
    refreshTokenToStore = existing?.refresh_token ?? null
  }

  const { error: upsertError } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'gmail',
        access_token,
        refresh_token: refreshTokenToStore,
        token_expires_at: tokenExpiresAt,
        channel_account_id: googleUserId,
        channel_account_name: gmailAddress,
        channel_username: gmailAddress,
        is_active: true,
        needs_reauth: false,
        status: 'active',
        metadata: {
          google_user_id: googleUserId,
          // Empty string until first poll — populated then for fast incremental sync.
          gmail_last_history_id: '',
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_type,channel_account_id' }
    )

  if (upsertError) {
    console.error('[gmail/callback] DB upsert error:', upsertError)
    return NextResponse.redirect(fail('gmail_error=db_save'))
  }

  // Fire discovery so Caye learns the business from sent mail. Fire-and-forget.
  try {
    const discoveryUrl = `${appUrl}/api/caye/discovery`
    fetch(discoveryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-discovery-secret': process.env.DISCOVERY_SECRET || '',
      },
      body: JSON.stringify({ workspaceId }),
    }).catch(err => console.error('[gmail/callback] Discovery trigger failed:', err))
  } catch (err) {
    console.error('[gmail/callback] Discovery fetch setup failed:', err)
  }

  return NextResponse.redirect(ok('gmail_connected=1'))
}
