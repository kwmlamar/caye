import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

interface MetaPage {
  id: string
  name: string
  access_token: string
}

async function savePageAccount(
  workspaceId: string,
  page: MetaPage
): Promise<string | null> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'messenger',
        channel_account_id: page.id,
        channel_account_name: page.name,
        channel_username: page.name,
        access_token: page.access_token,
        is_active: true,
        needs_reauth: false,
        metadata: { page_id: page.id, page_name: page.name },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_type,channel_account_id' }
    )
  return error?.message ?? null
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const workspaceId = searchParams.get('state')
  const metaError = searchParams.get('error')

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const settingsUrl = `${appUrl}/dashboard/${workspaceId}/settings`

  if (metaError || !code || !workspaceId) {
    console.error('[meta/callback] Denied or missing params:', { metaError, hasCode: !!code, workspaceId })
    return NextResponse.redirect(`${settingsUrl}?messenger_error=access_denied`)
  }

  const redirectUri = `${appUrl}/api/auth/meta/callback`

  // 1. Exchange code for short-lived user access token
  const tokenRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        client_id: process.env.META_APP_ID!,
        client_secret: process.env.META_APP_SECRET!,
        redirect_uri: redirectUri,
        code,
      })
  )
  const tokenData = (await tokenRes.json()) as Record<string, unknown>
  if (!tokenData.access_token) {
    console.error('[meta/callback] Token exchange failed:', tokenData)
    return NextResponse.redirect(`${settingsUrl}?messenger_error=token_exchange`)
  }

  // 2. Exchange for long-lived user token (60 days)
  const llRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID!,
        client_secret: process.env.META_APP_SECRET!,
        fb_exchange_token: String(tokenData.access_token),
      })
  )
  const llData = (await llRes.json()) as Record<string, unknown>
  const userToken = String(llData.access_token || tokenData.access_token)

  // 3. Fetch the pages this user manages (each has its own never-expiring page token)
  const pagesRes = await fetch(
    `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userToken)}`
  )
  const pagesData = (await pagesRes.json()) as { data?: MetaPage[] }
  const pages = pagesData.data ?? []

  if (!pages.length) {
    console.warn('[meta/callback] No Facebook Pages found for this user')
    return NextResponse.redirect(`${settingsUrl}?messenger_error=no_pages`)
  }

  // 4a. Single page — connect immediately
  if (pages.length === 1) {
    const dbErr = await savePageAccount(workspaceId, pages[0])
    if (dbErr) {
      console.error('[meta/callback] DB upsert failed:', dbErr)
      return NextResponse.redirect(`${settingsUrl}?messenger_error=db_save`)
    }
    return NextResponse.redirect(`${settingsUrl}?messenger_connected=1`)
  }

  // 4b. Multiple pages — pass list to settings so user can pick one
  const encoded = Buffer.from(
    JSON.stringify(pages.map(p => ({ id: p.id, name: p.name, token: p.access_token })))
  ).toString('base64url')
  return NextResponse.redirect(`${settingsUrl}?messenger_pages=${encoded}`)
}
