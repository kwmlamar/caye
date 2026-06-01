/**
 * gmail-token.ts
 *
 * Google OAuth token helper for Gmail-connected workspaces. Mirror of
 * lib/zoho-token.ts. Looks up the workspace's active Gmail connected_account,
 * refreshes the access_token if expiring within 5 minutes, persists, and
 * returns. Throws when no account is connected.
 */

import 'server-only'
import { createServiceClient } from './supabase-server'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface GmailAccountContext {
  accountRow: {
    id: string
    user_id: string
    access_token: string
    refresh_token: string | null
    token_expires_at: string | null
    channel_account_id: string
    channel_account_name: string | null
    metadata: Record<string, unknown>
  }
  accessToken: string
  /** The Gmail address (e.g. owner@business.com). */
  emailAddress: string
}

function tokenExpiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000
}

async function refreshGoogleToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: string } | null> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }).toString(),
  })
  const data = await res.json()
  if (!data.access_token) return null
  return {
    accessToken: data.access_token as string,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
  }
}

/**
 * Loads the workspace's active Gmail account, returning a guaranteed-fresh
 * access token. Throws if no account or refresh fails.
 */
export async function getGmailContext(workspaceId: string): Promise<GmailAccountContext> {
  const supabase = createServiceClient()

  const { data: account } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', workspaceId)
    .eq('channel_type', 'gmail')
    .eq('is_active', true)
    .maybeSingle()

  if (!account) {
    throw new Error(`No active Gmail account for workspace ${workspaceId}`)
  }

  const emailAddress = (account.channel_account_name as string) || ''
  let accessToken: string = account.access_token

  if (tokenExpiresSoon(account.token_expires_at)) {
    if (!account.refresh_token) {
      await fireGmailAuthFailurePing(workspaceId)
      throw new Error(`No refresh token for Gmail account ${emailAddress} — user must reconnect`)
    }
    const refreshed = await refreshGoogleToken(account.refresh_token)
    if (!refreshed) {
      await fireGmailAuthFailurePing(workspaceId)
      throw new Error(`Token refresh failed for Gmail account ${emailAddress}`)
    }
    accessToken = refreshed.accessToken
    await supabase
      .from('connected_accounts')
      .update({ access_token: refreshed.accessToken, token_expires_at: refreshed.expiresAt })
      .eq('id', account.id)
  }

  return { accountRow: account, accessToken, emailAddress }
}

async function fireGmailAuthFailurePing(workspaceId: string): Promise<void> {
  try {
    const { enqueueAuthFailurePing } = await import('./whatsapp/triggers')
    const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://meetcaye.com'
    await enqueueAuthFailurePing({
      workspaceId,
      service: 'Gmail',
      reconnectUrl: `${base}/dashboard/${workspaceId}/settings?tab=channels`,
    })
  } catch (err) {
    console.error('[gmail-token] auth-failure ping enqueue failed:', err)
  }
}
