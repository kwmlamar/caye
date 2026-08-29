import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'

const TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

export type FounderZohoAccount = {
  id: string
  founder_user_id: string
  account_id: string
  email_address: string
  access_token: string
  refresh_token: string | null
  token_expires_at: string | null
  metadata: Record<string, string>
  is_active: boolean
  needs_reauth: boolean
  last_polled_at: string | null
}

export function zohoMailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
}

export async function getFreshFounderZohoAccount(row: FounderZohoAccount): Promise<FounderZohoAccount> {
  if (row.token_expires_at && new Date(row.token_expires_at).getTime() >= Date.now() + 5 * 60_000) return row
  const supabase = createServiceClient()
  if (!row.refresh_token) {
    await supabase.from('founder_connected_accounts').update({ needs_reauth: true }).eq('id', row.id)
    throw new Error('Founder Zoho account needs reconnection')
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      refresh_token: row.refresh_token,
    }),
  })
  const data = await res.json() as { access_token?: string; expires_in?: number }
  if (!res.ok || !data.access_token) {
    await supabase.from('founder_connected_accounts').update({ needs_reauth: true }).eq('id', row.id)
    throw new Error('Founder Zoho token refresh failed')
  }
  const expires = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString()
  await supabase.from('founder_connected_accounts').update({
    access_token: data.access_token,
    token_expires_at: expires,
    needs_reauth: false,
    updated_at: new Date().toISOString(),
  }).eq('id', row.id)
  return { ...row, access_token: data.access_token, token_expires_at: expires, needs_reauth: false }
}
