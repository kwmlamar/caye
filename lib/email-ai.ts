/**
 * email-ai.ts
 *
 * Zoho Mail send helper with OAuth token refresh.
 * Caye reply generation lives in caye-reply.ts (the unified channel-aware engine).
 */

import { getZohoContext } from './zoho-token'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
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
  const { accountRow, accessToken, apiDomain, zohoAccountId } = await getZohoContext(workspaceId)
  const base = mailBase(apiDomain)

  const res = await fetch(`${base}/api/accounts/${zohoAccountId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fromAddress: accountRow.channel_account_name || '',
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
