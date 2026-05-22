import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const workspaceId = searchParams.get('state')
  const zohoError = searchParams.get('error')

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const settingsUrl = `${appUrl}/dashboard/${workspaceId}/settings?tab=channels`

  if (zohoError || !code || !workspaceId) {
    console.error('[zoho/callback] Access denied or missing params:', { zohoError, code: !!code, workspaceId })
    return NextResponse.redirect(`${settingsUrl}&zoho_error=access_denied`)
  }

  const redirectUri = `${appUrl}/api/auth/zoho/callback`

  // Exchange authorization code for tokens
  const tokenRes = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      redirect_uri: redirectUri,
    }).toString(),
  })

  const tokenData = await tokenRes.json()
  if (!tokenData.access_token) {
    console.error('[zoho/callback] Token exchange failed:', tokenData)
    return NextResponse.redirect(`${settingsUrl}&zoho_error=token_exchange`)
  }

  const { access_token, refresh_token, expires_in, api_domain } = tokenData
  const tokenExpiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString()

  // Fetch Zoho Mail account info to get account ID and email address
  const base = mailBase(api_domain || 'https://www.zohoapis.com')
  const accountsRes = await fetch(`${base}/api/accounts`, {
    headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
  })
  const accountsData = await accountsRes.json()
  const zohoAccount = accountsData?.data?.[0]

  if (!zohoAccount) {
    console.error('[zoho/callback] Failed to fetch Zoho account info:', accountsData)
    return NextResponse.redirect(`${settingsUrl}&zoho_error=account_fetch`)
  }

  const zohoAccountId = String(zohoAccount.accountId)

  // emailAddress is an array of { mailId, isPrimary, isAlias, isConfirmed }
  const emailList: Array<{ mailId: string; isPrimary: boolean }> = Array.isArray(zohoAccount.emailAddress)
    ? zohoAccount.emailAddress
    : []
  const primaryEmail = emailList.find(e => e.isPrimary)
  const zohoEmail: string = primaryEmail?.mailId || emailList[0]?.mailId || zohoAccount.incomingUserName || ''

  // Cache the inbox folderId so polling never needs the ZohoMail.folders.READ scope
  let inboxFolderId: string | null = null
  try {
    const foldersRes = await fetch(`${base}/api/accounts/${zohoAccountId}/folders`, {
      headers: { Authorization: `Zoho-oauthtoken ${access_token}` },
    })
    const foldersData = await foldersRes.json()
    const folders: Array<{ folderId?: string; id?: string; folderType?: string; folderName?: string; name?: string }> =
      Array.isArray(foldersData?.data) ? foldersData.data : []
    const inboxFolder = folders.find((f) => {
      const type = String(f.folderType || '').toLowerCase()
      const name = String(f.folderName || f.name || '').toLowerCase()
      return type === 'inbox' || name === 'inbox'
    })
    if (inboxFolder) inboxFolderId = String(inboxFolder.folderId || inboxFolder.id || '')
    console.log(`[zoho/callback] inbox folderId resolved: ${inboxFolderId ?? 'not found'} (${folders.length} folders)`)
  } catch (err) {
    console.warn('[zoho/callback] Could not fetch inbox folder ID:', err)
  }

  const supabase = createServiceClient()

  // Deactivate any existing email accounts for this workspace that are a different account
  await supabase
    .from('connected_accounts')
    .update({ is_active: false, status: 'inactive', needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'email')
    .neq('channel_account_id', zohoAccountId)

  // Upsert on the unique (channel_type, channel_account_id) constraint
  const { error: upsertError } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'email',
        access_token,
        refresh_token: refresh_token || null,
        token_expires_at: tokenExpiresAt,
        channel_account_id: zohoAccountId,
        channel_account_name: zohoEmail || null,
        channel_username: zohoEmail || null,
        is_active: true,
        needs_reauth: false,
        status: 'active',
        metadata: {
          zoho_api_domain: api_domain || 'https://www.zohoapis.com',
          zoho_account_id: zohoAccountId,
          inbox_folder_id: inboxFolderId,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_type,channel_account_id' }
    )

  if (upsertError) {
    console.error('[zoho/callback] DB upsert error:', upsertError)
    return NextResponse.redirect(`${settingsUrl}&zoho_error=db_save`)
  }

  return NextResponse.redirect(`${settingsUrl}&zoho_connected=1`)
}
