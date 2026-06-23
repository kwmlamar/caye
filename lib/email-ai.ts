/**
 * email-ai.ts
 *
 * Zoho Mail send helper with OAuth token refresh.
 * Caye reply generation lives in caye-reply.ts (the unified channel-aware engine).
 */

import { createServiceClient } from './supabase-server'
import { getZohoContext } from './zoho-token'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
}

/**
 * Look up the most recent inbound (customer) Zoho message-id for a given
 * conversation thread, so we can POST to Zoho's reply endpoint and have it
 * set RFC 5322 In-Reply-To / References headers automatically.
 *
 * Returns null if no inbound message is found — caller falls back to a
 * standalone send (no threading).
 */
async function findLatestInboundZohoMessageId(
  workspaceId: string,
  threadId: string
): Promise<string | null> {
  const supabase = createServiceClient()

  // Match by metadata.zoho_thread_id first (most precise), then by the
  // conversation's channel_conversation_id (covers older messages where
  // thread_id wasn't in metadata).
  const { data: byMetadata } = await supabase
    .from('unified_messages')
    .select('channel_message_id, sent_at')
    .eq('sender_type', 'customer')
    .contains('metadata', { zoho_thread_id: threadId })
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (byMetadata?.channel_message_id) return byMetadata.channel_message_id

  // Fallback: find via the conversation that owns this thread.
  const { data: conv } = await supabase
    .from('unified_conversations')
    .select('id')
    .eq('channel_conversation_id', threadId)
    .eq('channel_type', 'email')
    .limit(1)
    .maybeSingle()

  if (!conv?.id) return null

  const { data: byConv } = await supabase
    .from('unified_messages')
    .select('channel_message_id, sent_at')
    .eq('conversation_id', conv.id)
    .eq('sender_type', 'customer')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return byConv?.channel_message_id ?? null
}

/**
 * Sends a reply email via Zoho Mail API using the OAuth tokens stored for the workspace.
 * Automatically refreshes the access token if it's expiring within 5 minutes.
 *
 * THREADING: Uses Zoho's dedicated reply endpoint POST /messages/{originalMessageId}
 * with action='reply' when a previous inbound message exists for the thread. Zoho
 * sets In-Reply-To / References headers automatically. Falls back to a standalone
 * send only when no inbound message is found (e.g. operator initiating a brand-new
 * outbound). The Stallings 2026-05-29 case surfaced this: replies posted to the
 * generic /messages endpoint appear as new threads in Proton Mail / Apple Mail.
 *
 * @param to          - Recipient email address
 * @param subject     - Email subject (already prefixed with "Re: " by caller)
 * @param body        - Plain-text reply body
 * @param threadId    - Zoho thread ID, used to find the original message for threading
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

  const replyTargetId = await findLatestInboundZohoMessageId(workspaceId, threadId)

  const url = replyTargetId
    ? `${base}/api/accounts/${zohoAccountId}/messages/${replyTargetId}`
    : `${base}/api/accounts/${zohoAccountId}/messages`

  const requestBody: Record<string, unknown> = {
    fromAddress: accountRow.channel_account_name || '',
    toAddress: to,
    subject,
    content: body,
    mailFormat: 'plaintext',
  }
  if (replyTargetId) requestBody.action = 'reply'

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
    throw new Error(
      `Zoho Mail API error (HTTP ${res.status}, code ${code}): ${JSON.stringify(data).slice(0, 300)}`
    )
  }

  console.log(
    `[sendZohoReply] Sent to ${to}, threadId=${threadId}, ` +
    `replyTarget=${replyTargetId ?? 'none (standalone send)'}, ` +
    `zohoMsgId=${data.data?.messageId ?? 'unknown'}`
  )
}

/**
 * sendZohoEmail
 * -------------
 * Compose-and-send a brand-new email to any address from the workspace's
 * Zoho account. No reply-target lookup — always creates a new thread in
 * the recipient's inbox.
 *
 * Used by the dashboard chat's `send_email` tool so the operator can ask
 * Caye to fire off cold outreach / partner emails / one-off messages
 * without having to switch to their email client.
 */
export async function sendZohoEmail(
  to: string,
  subject: string,
  body: string,
  workspaceId: string
): Promise<{ messageId: string | null }> {
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

  console.log(
    `[sendZohoEmail] Sent to ${to}, subject="${subject}", zohoMsgId=${data.data?.messageId ?? 'unknown'}`
  )

  return { messageId: data.data?.messageId ?? null }
}

/**
 * createZohoReplyDraft
 * --------------------
 * Save a reply as a DRAFT in the workspace's Zoho Drafts folder rather
 * than sending it. The operator opens their normal email client, sees the
 * draft waiting on the customer thread, edits it, and sends from Zoho.
 *
 * Used by the receptionist-spec Q3+5+6+8 reframe: held items become Zoho
 * drafts so Karenda's resolution surface is her existing email client, not
 * the Caye dashboard.
 *
 * ⚠ VERIFICATION REQUIRED BEFORE WIRING TO PRODUCTION HOLD PATH ⚠
 * Zoho's REST API uses `mode: "draft"` on the standard /messages endpoint
 * to differentiate save-as-draft from send. This helper sends the same
 * payload as sendZohoReply with mode=draft added. If Zoho's API instead
 * sends the message (ignoring the mode flag), this would deliver an
 * unfinished reply to the customer — high-trust failure. Run one manual
 * verification (call this once for a known thread; check the Drafts folder
 * and the recipient's inbox) before letting the email webhook auto-call it.
 *
 * See receptionist-build-status.md for the verification steps.
 */
export async function createZohoReplyDraft(
  to: string,
  subject: string,
  body: string,
  threadId: string,
  workspaceId: string
): Promise<{ draftId: string | null }> {
  const { accountRow, accessToken, apiDomain, zohoAccountId } = await getZohoContext(workspaceId)
  const base = mailBase(apiDomain)

  const replyTargetId = await findLatestInboundZohoMessageId(workspaceId, threadId)

  const url = replyTargetId
    ? `${base}/api/accounts/${zohoAccountId}/messages/${replyTargetId}`
    : `${base}/api/accounts/${zohoAccountId}/messages`

  const requestBody: Record<string, unknown> = {
    fromAddress: accountRow.channel_account_name || '',
    toAddress: to,
    subject,
    content: body,
    mailFormat: 'plaintext',
    mode: 'draft',
  }
  if (replyTargetId) requestBody.action = 'reply'

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
    throw new Error(
      `Zoho Mail API draft error (HTTP ${res.status}, code ${code}): ${JSON.stringify(data).slice(0, 300)}`
    )
  }

  console.log(
    `[createZohoReplyDraft] Drafted to ${to}, threadId=${threadId}, ` +
    `replyTarget=${replyTargetId ?? 'none (standalone draft)'}, ` +
    `zohoMsgId=${data.data?.messageId ?? 'unknown'}`
  )

  return { draftId: data.data?.messageId ?? null }
}
