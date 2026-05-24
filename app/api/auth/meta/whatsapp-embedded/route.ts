import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { code, workspaceId } = body as { code: string; workspaceId: string }
  if (!code || !workspaceId) {
    return NextResponse.json({ error: 'code and workspaceId are required' }, { status: 400 })
  }

  // Exchange the Embedded Signup code for a short-lived user access token.
  // FB.login() codes don't require a redirect_uri in the exchange call.
  const tokenRes = await fetch(
    `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        client_id: process.env.META_APP_ID!,
        client_secret: process.env.META_APP_SECRET!,
        code,
      })
  )
  const tokenData = (await tokenRes.json()) as Record<string, unknown>
  if (!tokenData.access_token) {
    console.error('[whatsapp-embedded] Token exchange failed:', tokenData)
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 400 })
  }

  // Upgrade to a long-lived token (60 days)
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

  // Fetch WABAs the user granted access to via Embedded Signup
  const wabaRes = await fetch(
    `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts?access_token=${encodeURIComponent(userToken)}`
  )
  const wabaData = (await wabaRes.json()) as { data?: { id: string; name: string }[] }
  const wabas = wabaData.data ?? []

  const phoneNumbers: { id: string; name: string; token: string; display_phone_number: string }[] = []

  for (const waba of wabas) {
    try {
      const numRes = await fetch(
        `https://graph.facebook.com/v19.0/${waba.id}/phone_numbers?access_token=${encodeURIComponent(userToken)}`
      )
      const numData = (await numRes.json()) as {
        data?: { id: string; display_phone_number: string; verified_name?: string }[]
      }
      for (const num of numData.data ?? []) {
        phoneNumbers.push({
          id: num.id,
          name: num.verified_name || num.display_phone_number || waba.name,
          token: userToken,
          display_phone_number: num.display_phone_number,
        })
      }
    } catch (err) {
      console.error(`[whatsapp-embedded] Failed to fetch numbers for WABA ${waba.id}:`, err)
    }
  }

  if (!phoneNumbers.length) {
    console.warn('[whatsapp-embedded] No phone numbers found after Embedded Signup')
    return NextResponse.json({ error: 'No WhatsApp phone numbers found in your Meta Business account' }, { status: 404 })
  }

  // If only one number, connect it immediately
  if (phoneNumbers.length === 1) {
    const saved = await savePhone(workspaceId, phoneNumbers[0])
    if (saved) return NextResponse.json({ error: saved }, { status: 500 })
    return NextResponse.json({ success: true, phoneNumbers })
  }

  // Multiple numbers — return them all so the client can show a picker
  return NextResponse.json({ success: true, phoneNumbers })
}

async function savePhone(
  workspaceId: string,
  num: { id: string; name: string; token: string; display_phone_number: string }
): Promise<string | null> {
  const supabase = createServiceClient()

  await supabase
    .from('connected_accounts')
    .update({ is_active: false, needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'whatsapp')
    .neq('channel_account_id', num.id)

  const { error } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'whatsapp',
        channel_account_id: num.id,
        channel_account_name: num.name,
        channel_username: num.display_phone_number,
        access_token: num.token,
        is_active: true,
        needs_reauth: false,
        metadata: {
          phone_number_id: num.id,
          verified_name: num.name,
          display_phone_number: num.display_phone_number,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_type,channel_account_id' }
    )

  return error?.message ?? null
}
