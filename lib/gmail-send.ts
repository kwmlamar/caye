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
import { DispatchAmbiguousError } from './whatsapp/channel-dispatch'

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

async function gmailProviderSend(accessToken: string, raw: string, threadId: string): Promise<SendGmailReplyResult> {
  let res: Response
  try {
    res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, threadId }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new DispatchAmbiguousError(`Gmail provider send failed or its outcome is unknown: ${message}`, false)
  }

  let data: { id?: string; threadId?: string; error?: { message: string } }
  try {
    data = await res.json() as typeof data
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new DispatchAmbiguousError(`Gmail provider returned an unreadable send response (HTTP ${res.status}): ${message}`, false)
  }
  if (!res.ok || !data.id) {
    const errMsg = data.error?.message || JSON.stringify(data).slice(0, 300)
    throw new DispatchAmbiguousError(`Gmail send failed or its outcome is unknown (HTTP ${res.status}): ${errMsg}`, false)
  }
  return { gmailMessageId: data.id, threadId: data.threadId ?? threadId }
}

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
function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export interface GmailAttachment {
  filename: string
  mimeType: string
  bytes: Buffer
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
 *
 * Safety invariant: connected accounts marked metadata.observe_only=true are
 * read-only at the transport boundary. This is intentionally enforced here,
 * not just in a poller or prompt, so no current or future caller can send from
 * an observation-only mailbox by accident.
 */
export async function sendGmailReply(args: SendGmailReplyArgs): Promise<SendGmailReplyResult> {
  const { to, subject, body, gmailThreadId, conversationId, workspaceId } = args

  const gmail = await getGmailContext(workspaceId)
  const observeOnly = gmail.accountRow.metadata?.observe_only === true ||
    gmail.accountRow.metadata?.observe_only === 'true'
  if (observeOnly) {
    throw new Error(`Gmail outbound disabled: workspace ${workspaceId} is in observe-only mode`)
  }

  const { accessToken, emailAddress } = gmail
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

  const sent = await gmailProviderSend(accessToken, raw, gmailThreadId)

  console.log(
    `[sendGmailReply] Sent to ${to}, threadId=${sent.threadId}, ` +
    `msgId=${sent.gmailMessageId}, inReplyTo=${rfcInReplyTo ?? 'none (standalone)'}`
  )

  return sent
}

/** Sends a threaded multipart reply with one or more verified artifact attachments. */
export async function sendGmailReplyWithAttachments(args: SendGmailReplyArgs & { attachments: GmailAttachment[] }): Promise<SendGmailReplyResult> {
  if (args.attachments.length === 0) return sendGmailReply(args)
  const gmail = await getGmailContext(args.workspaceId)
  const observeOnly = gmail.accountRow.metadata?.observe_only === true || gmail.accountRow.metadata?.observe_only === 'true'
  if (observeOnly) throw new Error(`Gmail outbound disabled: workspace ${args.workspaceId} is in observe-only mode`)
  const rfcInReplyTo = await findLatestInboundRfcMessageId(args.conversationId)
  const boundary = `caye-freight-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const cleanHeader = (value: string) => value.replace(/[\r\n]/g, ' ')
  const headers = [
    `From: ${cleanHeader(gmail.emailAddress)}`, `To: ${cleanHeader(args.to)}`, `Subject: ${cleanHeader(args.subject)}`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]
  if (rfcInReplyTo) headers.push(`In-Reply-To: ${rfcInReplyTo}`, `References: ${rfcInReplyTo}`)
  const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${args.body}`]
  for (const attachment of args.attachments) {
    const filename = attachment.filename.replace(/[\r\n"]/g, '_')
    const encoded = attachment.bytes.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
    parts.push(`--${boundary}\r\nContent-Type: ${attachment.mimeType}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`)
  }
  parts.push(`--${boundary}--`)
  const raw = base64UrlEncode(`${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`)
  return gmailProviderSend(gmail.accessToken, raw, args.gmailThreadId)
}
