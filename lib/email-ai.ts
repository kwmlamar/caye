/**
 * email-ai.ts
 *
 * Zoho Mail send helper with OAuth token refresh.
 * Caye reply generation lives in caye-reply.ts (the unified channel-aware engine).
 */

import { createServiceClient } from './supabase-server'
import { getZohoContext } from './zoho-token'
import { sanitizeHumanFacingEmail } from './human-facing-email'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
}

/**
 * Look up a Zoho message-id to reply against for a given conversation
 * thread, so we can POST to Zoho's reply endpoint and have it set RFC 5322
 * In-Reply-To / References headers automatically.
 */
async function findReplyTargetZohoMessageId(
  workspaceId: string,
  threadId: string
): Promise<string | null> {
  const supabase = createServiceClient()

  const { data: byMetadata } = await supabase
    .from('unified_messages')
    .select('channel_message_id, sent_at')
    .eq('sender_type', 'customer')
    .contains('metadata', { zoho_thread_id: threadId })
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (byMetadata?.channel_message_id) return byMetadata.channel_message_id

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

  if (byConv?.channel_message_id) return byConv.channel_message_id

  const { data: outbound } = await supabase
    .from('unified_messages')
    .select('metadata, sent_at')
    .eq('conversation_id', conv.id)
    .eq('sender_type', 'business')
    .order('sent_at', { ascending: false })
    .limit(10)

  for (const row of outbound ?? []) {
    const id = (row.metadata as Record<string, unknown> | null)?.zoho_message_id
    if (typeof id === 'string' && id.length > 0) return id
  }

  return null
}

export async function sendZohoReply(
  to: string,
  subject: string,
  body: string,
  threadId: string,
  workspaceId: string
): Promise<{ messageId: string | null }> {
  const clean = sanitizeHumanFacingEmail({ to, subject, body })
  const { accountRow, accessToken, apiDomain, zohoAccountId } = await getZohoContext(workspaceId)
  const base = mailBase(apiDomain)
  const replyTargetId = await findReplyTargetZohoMessageId(workspaceId, threadId)
  const url = replyTargetId
    ? `${base}/api/accounts/${zohoAccountId}/messages/${replyTargetId}`
    : `${base}/api/accounts/${zohoAccountId}/messages`

  const requestBody: Record<string, unknown> = {
    fromAddress: accountRow.channel_account_name || '',
    toAddress: clean.to,
    subject: clean.subject,
    content: clean.body,
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
    `[sendZohoReply] Sent to ${clean.to}, threadId=${threadId}, ` +
    `replyTarget=${replyTargetId ?? 'none (standalone send)'}, ` +
    `zohoMsgId=${data.data?.messageId ?? 'unknown'}`
  )

  return { messageId: data.data?.messageId ?? null }
}

export async function sendZohoEmail(
  to: string,
  subject: string,
  body: string,
  workspaceId: string
): Promise<{ messageId: string | null }> {
  const clean = sanitizeHumanFacingEmail({ to, subject, body })
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
      toAddress: clean.to,
      subject: clean.subject,
      content: clean.body,
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
    `[sendZohoEmail] Sent to ${clean.to}, subject="${clean.subject}", zohoMsgId=${data.data?.messageId ?? 'unknown'}`
  )

  return { messageId: data.data?.messageId ?? null }
}

export async function createZohoReplyDraft(
  to: string,
  subject: string,
  body: string,
  threadId: string,
  workspaceId: string
): Promise<{ draftId: string | null }> {
  const clean = sanitizeHumanFacingEmail({ to, subject, body })
  const { accountRow, accessToken, apiDomain, zohoAccountId } = await getZohoContext(workspaceId)
  const base = mailBase(apiDomain)
  const replyTargetId = await findReplyTargetZohoMessageId(workspaceId, threadId)
  const url = replyTargetId
    ? `${base}/api/accounts/${zohoAccountId}/messages/${replyTargetId}`
    : `${base}/api/accounts/${zohoAccountId}/messages`

  const requestBody: Record<string, unknown> = {
    fromAddress: accountRow.channel_account_name || '',
    toAddress: clean.to,
    subject: clean.subject,
    content: clean.body,
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
    `[createZohoReplyDraft] Drafted to ${clean.to}, threadId=${threadId}, ` +
    `replyTarget=${replyTargetId ?? 'none (standalone draft)'}, ` +
    `zohoMsgId=${data.data?.messageId ?? 'unknown'}`
  )

  return { draftId: data.data?.messageId ?? null }
}
