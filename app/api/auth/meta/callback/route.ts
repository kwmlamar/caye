import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

interface MetaPage {
  id: string
  name: string
  access_token: string
  instagram_business_account?: {
    id: string
    username: string
    name?: string
  }
}

async function savePageAccount(
  workspaceId: string,
  page: MetaPage
): Promise<string | null> {
  const supabase = createServiceClient()

  // Deactivate any existing messenger connections for this workspace
  // that point to a different page (same pattern as Zoho callback)
  await supabase
    .from('connected_accounts')
    .update({ is_active: false, needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'messenger')
    .neq('channel_account_id', page.id)

  // Upsert on the actual DB unique constraint (channel_type, channel_account_id)
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
  if (error) {
    console.error('[meta/callback] savePageAccount upsert error:', error)
    return error.message
  }

  // Subscribe the page to the app's webhook so Meta delivers messages events
  try {
    const subRes = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(page.id)}/subscribed_apps` +
        `?subscribed_fields=messages&access_token=${encodeURIComponent(page.access_token)}`,
      { method: 'POST' }
    )
    const subData = (await subRes.json()) as Record<string, unknown>
    if (!subData.success) {
      console.error('[meta/callback] Page webhook subscription failed:', subData)
    } else {
      console.log(`[meta/callback] Page ${page.id} subscribed to webhook`)
    }
  } catch (err) {
    console.error('[meta/callback] Page webhook subscription error:', err)
  }

  return null
}

async function saveInstagramAccount(
  workspaceId: string,
  account: { id: string; name: string; token: string }
): Promise<string | null> {
  const supabase = createServiceClient()

  // Deactivate any existing instagram connections for this workspace
  await supabase
    .from('connected_accounts')
    .update({ is_active: false, needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'instagram')
    .neq('channel_account_id', account.id)

  const { error } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'instagram',
        channel_account_id: account.id,
        channel_account_name: account.name,
        channel_username: account.name,
        access_token: account.token,
        is_active: true,
        needs_reauth: false,
        metadata: { instagram_business_id: account.id, instagram_username: account.name },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_type,channel_account_id' }
    )
  if (error) {
    console.error('[meta/callback] saveInstagramAccount upsert error:', error)
  }
  return error?.message ?? null
}

async function saveWhatsAppAccount(
  workspaceId: string,
  account: { id: string; name: string; token: string; display_phone_number: string }
): Promise<string | null> {
  const supabase = createServiceClient()

  // Deactivate any existing whatsapp connections for this workspace
  await supabase
    .from('connected_accounts')
    .update({ is_active: false, needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'whatsapp')
    .neq('channel_account_id', account.id)

  const { error } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'whatsapp',
        channel_account_id: account.id,
        channel_account_name: account.name,
        channel_username: account.display_phone_number,
        access_token: account.token,
        is_active: true,
        needs_reauth: false,
        metadata: { phone_number_id: account.id, verified_name: account.name, display_phone_number: account.display_phone_number },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_type,channel_account_id' }
    )
  if (error) {
    console.error('[meta/callback] saveWhatsAppAccount upsert error:', error)
  }
  return error?.message ?? null
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state') || ''
  const metaError = searchParams.get('error')

  // Parse state (format: workspaceId:channel:source)
  const [workspaceId, channelVal, sourceVal] = state.split(':')
  const channel = channelVal || 'messenger'
  const isMobile = sourceVal === 'mobile'

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const mobileUrl = `${appUrl}/m/${workspaceId}`
  // 'founder' = connected from Caye Command's Channels card — send them
  // back there instead of a settings tab they never navigated from.
  const desktopUrl = sourceVal === 'founder'
    ? `${appUrl}/dashboard/${workspaceId}`
    : `${appUrl}/dashboard/${workspaceId}/settings?tab=channels`
  const desktopSep = desktopUrl.includes('?') ? '&' : '?'

  // Mobile gets a clean redirect — mobile app reads state from Supabase, not query params
  const ok = (param: string) => isMobile ? mobileUrl : `${desktopUrl}${desktopSep}${param}`
  const fail = (param: string) => isMobile ? mobileUrl : `${desktopUrl}${desktopSep}${param}`

  if (metaError || !code || !workspaceId) {
    console.error('[meta/callback] Denied or missing params:', { metaError, hasCode: !!code, workspaceId })
    return NextResponse.redirect(fail(`${channel}_error=access_denied`))
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
    return NextResponse.redirect(fail(`${channel}_error=token_exchange`))
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

  if (channel === 'whatsapp') {
    // 1. Fetch WABAs managed by this user/business
    const wabaRes = await fetch(
      `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts?access_token=${encodeURIComponent(userToken)}`
    )
    const wabaData = (await wabaRes.json()) as { data?: { id: string; name: string }[] }
    const wabas = wabaData.data ?? []

    const whatsappNumbers: { id: string; name: string; token: string; display_phone_number: string }[] = []
    
    // 2. Fetch phone numbers for each WABA
    for (const waba of wabas) {
      try {
        const numRes = await fetch(
          `https://graph.facebook.com/v19.0/${waba.id}/phone_numbers?access_token=${encodeURIComponent(userToken)}`
        )
        const numData = (await numRes.json()) as {
          data?: { id: string; display_phone_number: string; verified_name?: string }[]
        }
        const nums = numData.data ?? []
        for (const num of nums) {
          whatsappNumbers.push({
            id: num.id,
            name: num.verified_name || num.display_phone_number || waba.name,
            token: userToken,
            display_phone_number: num.display_phone_number,
          })
        }
      } catch (err) {
        console.error(`[meta/callback] Failed to fetch numbers for WABA ${waba.id}:`, err)
      }
    }

    if (!whatsappNumbers.length) {
      console.warn('[meta/callback] No WhatsApp accounts/phone numbers found')
      return NextResponse.redirect(fail('whatsapp_error=no_whatsapp_accounts'))
    }

    // Single WhatsApp number — connect immediately
    if (whatsappNumbers.length === 1) {
      const dbErr = await saveWhatsAppAccount(workspaceId, whatsappNumbers[0])
      if (dbErr) {
        console.error('[meta/callback] DB upsert failed:', dbErr)
        return NextResponse.redirect(fail('whatsapp_error=db_save'))
      }
      return NextResponse.redirect(ok('whatsapp_connected=1'))
    }

    // Multiple WhatsApp numbers — show picker (desktop only; mobile just connects first)
    if (isMobile) {
      const dbErr = await saveWhatsAppAccount(workspaceId, whatsappNumbers[0])
      if (dbErr) return NextResponse.redirect(mobileUrl)
      return NextResponse.redirect(mobileUrl)
    }
    const encoded = Buffer.from(JSON.stringify(whatsappNumbers)).toString('base64url')
    return NextResponse.redirect(`${desktopUrl}${desktopSep}whatsapp_pages=${encoded}`)
  }

  // 3. Fetch pages (optionally including instagram_business_account if connecting Instagram)
  const fields = channel === 'instagram'
    ? 'id,name,access_token,instagram_business_account{id,username,name}'
    : 'id,name,access_token'

  const pagesRes = await fetch(
    `https://graph.facebook.com/v19.0/me/accounts?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(userToken)}`
  )
  const pagesData = (await pagesRes.json()) as { data?: MetaPage[] }
  const pages = pagesData.data ?? []

  if (!pages.length) {
    console.warn('[meta/callback] No Facebook Pages found for this user')
    return NextResponse.redirect(fail(`${channel}_error=no_pages`))
  }

  if (channel === 'instagram') {
    // Filter and map only pages that have a linked Instagram Business Account
    const instagramAccounts = pages
      .filter(p => p.instagram_business_account)
      .map(p => ({
        id: p.instagram_business_account!.id,
        name: p.instagram_business_account!.name || p.instagram_business_account!.username,
        token: p.access_token,
      }))

    if (!instagramAccounts.length) {
      console.warn('[meta/callback] No linked Instagram accounts found')
      return NextResponse.redirect(fail('instagram_error=no_instagram_accounts'))
    }

    // Single Instagram account — connect immediately
    if (instagramAccounts.length === 1) {
      const dbErr = await saveInstagramAccount(workspaceId, instagramAccounts[0])
      if (dbErr) {
        console.error('[meta/callback] DB upsert failed:', dbErr)
        return NextResponse.redirect(fail('instagram_error=db_save'))
      }
      return NextResponse.redirect(ok('instagram_connected=1'))
    }

    // Multiple Instagram accounts — show picker (desktop only; mobile just connects first)
    if (isMobile) {
      const dbErr = await saveInstagramAccount(workspaceId, instagramAccounts[0])
      if (dbErr) return NextResponse.redirect(mobileUrl)
      return NextResponse.redirect(mobileUrl)
    }
    const encoded = Buffer.from(JSON.stringify(instagramAccounts)).toString('base64url')
    return NextResponse.redirect(`${desktopUrl}${desktopSep}instagram_pages=${encoded}`)
  }

  // Default flow: Messenger (Facebook Page connection)
  // 4a. Single page — connect immediately
  if (pages.length === 1) {
    const dbErr = await savePageAccount(workspaceId, pages[0])
    if (dbErr) {
      console.error('[meta/callback] DB upsert failed:', dbErr)
      return NextResponse.redirect(fail('messenger_error=db_save'))
    }
    return NextResponse.redirect(ok('messenger_connected=1'))
  }

  // 4b. Multiple pages — mobile auto-picks the first; desktop shows a picker
  if (isMobile) {
    const dbErr = await savePageAccount(workspaceId, pages[0])
    if (dbErr) console.error('[meta/callback] DB upsert failed (mobile auto-pick):', dbErr)
    return NextResponse.redirect(mobileUrl)
  }
  const encoded = Buffer.from(
    JSON.stringify(pages.map(p => ({ id: p.id, name: p.name, token: p.access_token })))
  ).toString('base64url')
  return NextResponse.redirect(`${desktopUrl}${desktopSep}messenger_pages=${encoded}`)
}
