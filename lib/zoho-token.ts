/**
 * zoho-token.ts
 *
 * Shared Zoho OAuth token helper. Looks up the workspace's active Zoho-backed
 * connected_account, refreshes the access_token if it's expiring within 5 minutes,
 * persists the refreshed token, and returns it.
 */

import 'server-only'
import { createServiceClient } from './supabase-server'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

export interface ZohoAccountContext {
  accountRow: {
    id: string
    user_id: string
    access_token: string
    refresh_token: string | null
    token_expires_at: string | null
    channel_account_id: string
    channel_account_name: string | null
    metadata: Record<string, unknown>
    sync_calendar?: boolean
  }
  accessToken: string
  apiDomain: string
  zohoAccountId: string
}

function tokenExpiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000
}

async function refreshZohoToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: string } | null> {
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
  if (!data.access_token) return null
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
  }
}

/**
 * Loads the workspace's active Zoho email account, returning a guaranteed-fresh
 * access token. Throws if no account or refresh fails.
 */
export async function getZohoContext(workspaceId: string): Promise<ZohoAccountContext> {
  const supabase = createServiceClient()

  const { data: account } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', workspaceId)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (!account) {
    throw new Error(`No active Zoho account for workspace ${workspaceId}`)
  }

  const meta = (account.metadata || {}) as Record<string, string>
  const apiDomain = meta.zoho_api_domain || 'https://www.zohoapis.com'
  const zohoAccountId = meta.zoho_account_id || account.channel_account_id

  let accessToken: string = account.access_token

  if (tokenExpiresSoon(account.token_expires_at)) {
    if (!account.refresh_token) {
      throw new Error(`No refresh token for Zoho account ${zohoAccountId} — user must reconnect`)
    }
    const refreshed = await refreshZohoToken(account.refresh_token)
    if (!refreshed) {
      throw new Error(`Token refresh failed for Zoho account ${zohoAccountId}`)
    }
    accessToken = refreshed.accessToken
    await supabase
      .from('connected_accounts')
      .update({ access_token: refreshed.accessToken, token_expires_at: refreshed.expiresAt })
      .eq('id', account.id)
  }

  return { accountRow: account, accessToken, apiDomain, zohoAccountId }
}
