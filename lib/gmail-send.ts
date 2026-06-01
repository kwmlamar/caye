/**
 * gmail-send.ts
 *
 * Gmail outbound reply helper. Mirrors lib/email-ai.ts sendZohoReply.
 *
 * Threading: Gmail accepts an optional `threadId` query param on its send
 * endpoint that handles in-Gmail threading. For correctness across other
 * mail clients (Apple Mail, Proton, etc.) we ALSO set RFC 5322 In-Reply-To
 * and References headers pointing at the original inbound RFC Message-ID.
 * The Stallings 2026-05-29 case in the Zoho path showed why this matters —
 * threading via the bare /messages endpoint alone broke in Proton/Apple.
 */

import 'server-only'
import { createServiceClient } from './supabase-server'
import { getGmailContext } from './gmail-token'

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

/**
 * Look up the most recent inbound (customer) Gmail message in a conversation
 * and return its RFC 822 Message-ID header value. Returns null if not stored.
 */
async function findLatestInboundRfcMessageId(
  conversationId: string
): Promise<string | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('unified_messages')
    .select('metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const meta = (data.metadata ?? {}) as Record<string, unknown>
  const rfcId = meta.gmail_rfc_message_id as string | null | undefined
  return rfcId || null
}

/**
 * base64url encoding (RFC 4648 §5) — Gmail's required encoding for raw
 * messages. The spec is base64 with + → -, / → _, and no padding.
 */
function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

interface SendGmailReplyArgs {
  /** Recipient email address. */
  to: string
  /** Subject line — caller is responsible for prepending "Re: " when appropriate. */
  subject: string
  /** Plain-text body. */
  body: string
  /** Gmail threadId from the original message (drives Gmail-side threading). */
  gmailThreadId: string
  /** Our conversation row id — used to look up the RFC Message-ID for proper threading headers. */
  conversationId: string
  /** Workspace whose Gmail account is sending. */
  workspaceId: string
}

interface SendGmailReplyResult {
  gmailMessageId: string
  threadId: string
}

/**
 * Sends a plain-text reply via Gmail's send endpoint. Throws on any non-2xx.
 */
export async function sendGmailReply(args: SendGmailReplyArgs): Promise<SendGmailReplyResult> {
  const { to, subject, body, gmailThreadId, conversationId, workspaceId } = args

  const { accessToken, emailAddress } = await getGmailContext(workspaceId)
  const rfcInReplyTo = await findLatestInboundRfcMessageId(conversationId)

  // RFC 822 message. Keep headers ASCII-safe; body can be UTF-8.
  const headers = [
    `From: ${emailAddress}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ]
  if (rfcInReplyTo) {
    headers.push(`In-Reply-To: ${rfcInReplyTo}`)
    headers.push(`References: ${rfcInReplyTo}`)
  }
  const rfcMessage = `${headers.join('\r\n')}\r\n\r\n${body}`
  const raw = base64UrlEncode(rfcMessage)

  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw, threadId: gmailThreadId }),
  })

  const data = await res.json() as { id?: string; threadId?: string; error?: { message: string } }
  if (!res.ok || !data.id) {
    const errMsg = data.error?.message || JSON.stringify(data).slice(0, 300)
    throw new Error(`Gmail send failed (HTTP ${res.status}): ${errMsg}`)
  }

  console.log(
    `[sendGmailReply] Sent to ${to}, threadId=${data.threadId ?? gmailThreadId}, ` +
    `msgId=${data.id}, inReplyTo=${rfcInReplyTo ?? 'none (standalone)'}`
  )

  return {
    gmailMessageId: data.id,
    threadId: data.threadId ?? gmailThreadId,
  }
}
