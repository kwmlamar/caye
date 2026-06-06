/**
 * One-off: send a brand-new outbound email from Bimini's connected Zoho
 * account to V_carmona@live.com. Standalone send (no thread).
 *
 * Run from Products/Caye/: npx tsx scripts/send-vanessa-bimini.ts
 *
 * Self-contained — does not import lib/* (which pulls in `server-only`).
 */

import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const WORKSPACE_ID = '653257d9-c0f1-4271-be6d-3e2596fd893e' // Bimini Island Tours
const TO = 'V_carmona@live.com'
const SUBJECT = 'Your Group Tour Options — Bimini Island Tours'
const BODY = `Hi Vanessa,

Thank you for your interest in Bimini Island Tours! We're excited to host your group of 20. Below are the three options we've put together for you. Please note that these are special discounted rates.

--
Option 1 — Bimini Orientation Golf Cart Tour (1 hr)

A quick, guided orientation of Bimini across 4 golf carts — a great introduction for your group.

Total: $1,300 ($65/person — regularly $85/person)
--
Option 2 — Fully Guided Tour (2 hrs)

Your group travels in 1 air conditioned van (up to 12 persons) and 2 golf carts, with a certified local guide leading the full experience.

Total: $1,900 ($95/person — regularly $110/person)
--
Option 3 — North Bimini Heritage Tour (2 hrs)

A structured, fully guided tour through Bimini's most significant historical and cultural sites. All site admissions included.

Total: $1,900 ($95/person — regularly $110/person)
--
Your tour is scheduled for June 25th at 9:30 AM. Full payment is due 7 days prior to your tour date.

Please let us know which option works best for your group and we'll get everything confirmed for you.

Bimini Island Tours · 242 473 0233 · 242 814 8687 · info@tourbimini.com
`

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
}

function tokenExpiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000
}

async function refreshZohoToken(refreshToken: string) {
  const res = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }).toString(),
  })
  const data = await res.json()
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data).slice(0, 300)}`)
  }
  return {
    accessToken: data.access_token as string,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
  }
}

async function main() {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!supaUrl || !supaKey) throw new Error('Supabase env missing')
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } })

  const { data: account, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', WORKSPACE_ID)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()
  if (error || !account) throw new Error(`No active Zoho account: ${error?.message}`)

  const meta = (account.metadata || {}) as Record<string, string>
  const apiDomain = meta.zoho_api_domain || 'https://www.zohoapis.com'
  const zohoAccountId = meta.zoho_account_id || account.channel_account_id

  let accessToken: string = account.access_token
  if (tokenExpiresSoon(account.token_expires_at)) {
    if (!account.refresh_token) throw new Error('No refresh token; user must reconnect')
    const r = await refreshZohoToken(account.refresh_token)
    accessToken = r.accessToken
    await supabase
      .from('connected_accounts')
      .update({ access_token: r.accessToken, token_expires_at: r.expiresAt })
      .eq('id', account.id)
    console.log('[send] refreshed access token')
  }

  const url = `${mailBase(apiDomain)}/api/accounts/${zohoAccountId}/messages`
  const fromAddress = account.channel_account_name || 'info@tourbimini.com'
  const requestBody = {
    fromAddress,
    toAddress: TO,
    subject: SUBJECT,
    content: BODY,
    mailFormat: 'plaintext',
  }

  console.log('[send] POST', url)
  console.log('[send] from=%s to=%s subject=%s', fromAddress, TO, SUBJECT)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })
  const data = await res.json()
  const code = data.status?.code
  if (!res.ok || (code !== 200 && code !== 201)) {
    console.error('[send] FAILED', res.status, JSON.stringify(data))
    process.exit(1)
  }
  console.log('[send] OK zohoMsgId=%s', data.data?.messageId ?? 'unknown')
}

main().catch(err => {
  console.error('[send] ERROR', err)
  process.exit(1)
})
