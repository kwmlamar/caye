/**
 * email-ai.ts
 *
 * Two exports:
 *   generateEmailReply — calls Claude claude-sonnet-4-6 to draft a reply
 *   sendZohoReply      — sends via Zoho Mail API, handling token refresh
 */

import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from './supabase-server'
import type { VoiceProfile } from './voice-profile'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
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
 * Generates an email reply using Claude claude-sonnet-4-6.
 *
 * @param systemPrompt  - The workspace's AI persona / instruction set
 * @param inbound       - The email being replied to
 * @returns Plain-text reply body
 */
export async function generateEmailReply(
  systemPrompt: string,
  inbound: { senderName: string; subject: string; body: string },
  voiceProfile?: VoiceProfile
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let fullSystem = systemPrompt

  if (voiceProfile) {
    fullSystem +=
      '\n\nVOICE PROFILE — write in this person\'s actual style:\n' +
      `- Formality: ${voiceProfile.formality_level}\n` +
      `- Style: ${voiceProfile.writing_style}\n` +
      `- Common phrases to use naturally: ${voiceProfile.common_phrases.join(', ')}\n` +
      `- Typical greeting: ${voiceProfile.greeting_style}\n` +
      `- Typical sign-off: ${voiceProfile.signoff_style}\n` +
      `- Tone notes: ${voiceProfile.tone_notes}`
  }

  fullSystem +=
    '\n\nWrite only the reply body — no "To:", "Subject:", or any header lines. ' +
    'Do not use markdown formatting (no **bold**, no bullet hyphens, no headers). ' +
    'Plain prose only. Sign off naturally without wrapping your name in asterisks.'

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: fullSystem,
    messages: [
      {
        role: 'user',
        content: `Reply to this email:\n\nFrom: ${inbound.senderName}\nSubject: ${inbound.subject}\n\n${inbound.body}`,
      },
    ],
  })

  const block = response.content[0]
  if (block.type !== 'text') {
    throw new Error(`Unexpected Claude response block type: ${block.type}`)
  }
  return block.text
}

/**
 * Sends a reply email via Zoho Mail API using the OAuth tokens stored for the workspace.
 * Automatically refreshes the access token if it's expiring within 5 minutes.
 *
 * @param to          - Recipient email address
 * @param subject     - Email subject (already prefixed with "Re: " by caller)
 * @param body        - Plain-text reply body
 * @param threadId    - Zoho thread ID (used for metadata, not for threading the send)
 * @param workspaceId - The customer/workspace UUID whose Zoho account to send from
 */
export async function sendZohoReply(
  to: string,
  subject: string,
  body: string,
  threadId: string,
  workspaceId: string
): Promise<void> {
  const supabase = createServiceClient()

  const { data: account } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', workspaceId)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (!account) {
    throw new Error(`No active Zoho email account for workspace ${workspaceId}`)
  }

  const meta = (account.metadata || {}) as Record<string, string>
  const base = mailBase(meta.zoho_api_domain || 'https://www.zohoapis.com')
  const accountId = meta.zoho_account_id || account.channel_account_id

  let accessToken: string = account.access_token

  if (tokenExpiresSoon(account.token_expires_at)) {
    if (!account.refresh_token) {
      throw new Error(`No refresh token for Zoho account ${accountId}`)
    }
    const refreshed = await refreshZohoToken(account.refresh_token)
    if (!refreshed) {
      throw new Error(`Token refresh failed for Zoho account ${accountId}`)
    }
    accessToken = refreshed.accessToken
    await supabase
      .from('connected_accounts')
      .update({ access_token: refreshed.accessToken, token_expires_at: refreshed.expiresAt })
      .eq('id', account.id)
  }

  const res = await fetch(`${base}/api/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fromAddress: account.channel_account_name || '',
      toAddress: to,
      subject,
      content: body,
      mailFormat: 'plaintext',
    }),
  })

  const data = await res.json()
  const code = data.status?.code
  if (!res.ok || (code !== 200 && code !== 201)) {
    throw new Error(
      `Zoho Mail API error (HTTP ${res.status}, code ${code}): ${JSON.stringify(data).slice(0, 300)}`
    )
  }

  console.log(`[sendZohoReply] Sent to ${to}, threadId=${threadId}, zohoMsgId=${data.data?.messageId ?? 'unknown'}`)
}
