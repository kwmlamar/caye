/**
 * GET /api/email/gmail-poll
 *
 * Cron-triggered poller for Gmail-connected workspaces. Mirrors the shape of
 * /api/email/poll (Zoho) but uses the Gmail API. v1 is inbound-only +
 * Caye auto-reply via the shared generateCayeAutoReply engine.
 *
 * Secured with CRON_SECRET via x-cron-secret header.
 *
 * What v1 deliberately does NOT do (vs. the Zoho poll):
 *   - No sent-folder backfill / owner-correction detection (read-only scope;
 *     can add when we move to gmail.modify + gmail.send for outbound)
 *   - No Web3Forms / payment-receipt interception (Karenda-specific; revisit
 *     if another Gmail customer needs it)
 *   - No mark-as-read on Gmail side. Dedup is by Gmail messageId in
 *     unified_messages.channel_message_id — read-state on the user's side
 *     is unaffected.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { htmlToPlainText } from '@/lib/email-text'
import { sendGmailReply } from '@/lib/gmail-send'

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Page size for the unread-listing call. Caye is meant to keep the inbox
// near-zero, so 25/run is well above steady-state and gives headroom on
// the first poll after a connection.
const LIST_PAGE_SIZE = 25

interface GmailHeader { name: string; value: string }
interface GmailMessagePart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number }
  parts?: GmailMessagePart[]
}
interface GmailMessage {
  id: string
  threadId: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailMessagePart
  snippet?: string
}

function tokenExpiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000
}

async function refreshAccessToken(
  token: string
): Promise<{ accessToken: string; expiresAt: string } | null> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: token,
    }).toString(),
  })
  const data = await res.json()
  if (!data.access_token) return null
  return {
    accessToken: data.access_token as string,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
  }
}

function findHeader(payload: GmailMessagePart | undefined, name: string): string {
  const headers = payload?.headers || []
  const h = headers.find(x => x.name.toLowerCase() === name.toLowerCase())
  return h?.value || ''
}

function decodeBase64Url(b64: string): string {
  // Gmail returns base64url. Node Buffer handles base64 with replacements.
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/')
  try {
    return Buffer.from(normalized, 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

/**
 * Walks the MIME tree and returns the best plain-text body we can find.
 * Prefers text/plain; falls back to text/html (passed through htmlToPlainText).
 */
function extractBody(part: GmailMessagePart | undefined): string {
  if (!part) return ''

  const collected: { plain: string; html: string } = { plain: '', html: '' }

  const walk = (node: GmailMessagePart) => {
    const mime = (node.mimeType || '').toLowerCase()
    if (node.body?.data) {
      const decoded = decodeBase64Url(node.body.data)
      if (mime === 'text/plain' && !collected.plain) collected.plain = decoded
      else if (mime === 'text/html' && !collected.html) collected.html = decoded
    }
    if (node.parts) for (const p of node.parts) walk(p)
  }
  walk(part)

  if (collected.plain) return htmlToPlainText(collected.plain)
  if (collected.html) return htmlToPlainText(collected.html)
  return ''
}

function extractEmail(raw: string): string {
  return (
    raw.match(/<([^>]+)>/)?.[1]?.toLowerCase().trim() ||
    raw.toLowerCase().trim()
  )
}

function extractName(raw: string): string {
  // "Karenda <karenda@…>" → "Karenda" ; "karenda@…" → "karenda"
  const m = raw.match(/^([^<]+)<[^>]+>$/)
  if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  return raw.split('@')[0]
}

// ── Newsletter / mass-mailer detector (kept in lockstep with /api/email/poll) ──
const BLAST_PHRASES = [
  /\bunsubscribe\b/i,
  /manage (?:your )?(?:subscription|preferences|email preferences)/i,
  /\bopted[\s-]?in\b/i,
  /\bview (?:this email )?in (?:your )?browser\b/i,
  /update (?:your )?(?:email )?preferences/i,
  /stop receiving (?:these|our|my) emails?/i,
  /change your subscription/i,
  /you (?:are|'re) (?:part of|receiving|getting) (?:this|the|our)/i,
]
const INVISIBLE_CHARS_RE = /[͏­​-‏⁠᠎﻿]/g

function detectNewsletter(body: string, subject: string, fromEmail: string): string | null {
  if (!body) return null
  const signals: string[] = []
  const invisibleCount = (body.match(INVISIBLE_CHARS_RE) || []).length
  if (invisibleCount >= 30) signals.push(`${invisibleCount} invisible padding chars`)
  let phraseHits = 0
  for (const re of BLAST_PHRASES) if (re.test(body)) phraseHits++
  if (phraseHits >= 2) signals.push(`${phraseHits} mass-mailer phrases`)
  const fromDomain = fromEmail.split('@')[1]?.toLowerCase() || ''
  if (/\b(mailchimp|sendgrid|sparkpost|mailgun|constantcontact|hubspot|convertkit|activecampaign|mailerlite|klaviyo|emailoctopus|aweber|cmail\d+)\b/.test(fromDomain)) {
    signals.push(`ESP sender domain (${fromDomain})`)
  }
  if (signals.length >= 2) return signals.join('; ')
  if (invisibleCount >= 30 && phraseHits >= 1) return `${invisibleCount} invisible chars + ${phraseHits} blast phrase`
  if (phraseHits >= 3) return `${phraseHits} mass-mailer phrases`
  if (/^(weekly|newsletter|digest|edition)\b/i.test(subject) && phraseHits >= 1) {
    return `newsletter-pattern subject + ${phraseHits} blast phrase`
  }
  return null
}

type Supabase = ReturnType<typeof createServiceClient>
type Account = Record<string, unknown>

async function processGmailMessage(
  supabase: Supabase,
  account: Account,
  message: GmailMessage,
  accessToken: string
): Promise<'processed' | 'skipped' | 'error' | 'held'> {
  const messageId = message.id
  if (!messageId) return 'skipped'

  // Dedup by Gmail message ID
  const { data: existing } = await supabase
    .from('unified_messages')
    .select('id')
    .eq('channel_message_id', messageId)
    .maybeSingle()
  if (existing) return 'skipped'

  const fromRaw = findHeader(message.payload, 'From')
  const fromEmail = extractEmail(fromRaw)
  const fromName = extractName(fromRaw)
  const subject = findHeader(message.payload, 'Subject') || '(no subject)'
  // RFC 822 Message-ID header — needed for In-Reply-To/References when Caye
  // replies, so the thread lands correctly in Gmail/Proton/Apple Mail.
  const rfcMessageId = findHeader(message.payload, 'Message-ID') || findHeader(message.payload, 'Message-Id')
  const receivedMs = Number(message.internalDate || Date.now())
  const receivedTime = new Date(receivedMs).toISOString()
  const threadId = message.threadId || messageId
  const workspaceId = String(account.user_id)
  const ownEmail = String(account.channel_account_name || '').toLowerCase().trim()

  // Self-loop guard
  if (!fromEmail || fromEmail === ownEmail) return 'skipped'

  const body = extractBody(message.payload)
  if (!body) {
    console.warn(`[gmail-poll] empty body for ${messageId} (subject="${subject}")`)
  }

  // Historical-message guard: only auto-reply to mail received after connect
  const accountConnectedAt = String(account.updated_at || account.created_at || '')
  const isHistorical = accountConnectedAt
    ? receivedMs < new Date(accountConnectedAt).getTime()
    : false

  // Find or create conversation (one per email per account — same rule as Zoho)
  let conversationId: string
  const { data: existingConv } = await supabase
    .from('unified_conversations')
    .select('id, metadata')
    .eq('connected_account_id', String(account.id))
    .eq('channel_type', 'gmail')
    .eq('customer_id', fromEmail)
    .maybeSingle()

  if (existingConv) {
    const existingMeta = (existingConv.metadata ?? {}) as Record<string, unknown>
    const existingThreads = ((existingMeta.related_thread_ids as string[] | undefined) ?? []).slice()
    if (!existingThreads.includes(threadId)) existingThreads.push(threadId)
    await supabase
      .from('unified_conversations')
      .update({
        metadata: {
          ...existingMeta,
          subject: existingMeta.subject ?? subject,
          from: existingMeta.from ?? fromRaw,
          thread_id: existingMeta.thread_id ?? threadId,
          related_thread_ids: existingThreads,
        },
      })
      .eq('id', existingConv.id)
    conversationId = String(existingConv.id)
  } else {
    const { data: created, error: convErr } = await supabase
      .from('unified_conversations')
      .insert({
        connected_account_id: String(account.id),
        channel_type: 'gmail',
        channel_conversation_id: threadId,
        customer_name: fromName,
        customer_id: fromEmail,
        status: 'open',
        metadata: {
          subject,
          from: fromRaw,
          thread_id: threadId,
          related_thread_ids: [threadId],
        },
      })
      .select('id')
      .single()
    if (convErr || !created) {
      console.error(`[gmail-poll] Conversation create failed for ${messageId}:`, convErr)
      return 'error'
    }
    conversationId = String(created.id)
  }

  // Insert the customer message
  const { error: msgErr } = await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: messageId,
    sender_type: 'customer',
    content: body,
    message_type: 'text',
    sent_at: receivedTime,
    status: 'received',
    metadata: {
      subject,
      from: fromRaw,
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      gmail_rfc_message_id: rfcMessageId || null,
      source: 'gmail',
    },
  })
  if (msgErr) {
    console.error(`[gmail-poll] Message insert failed for ${messageId}:`, msgErr)
    return 'error'
  }

  // Refresh conversation summary fields
  await supabase
    .from('unified_conversations')
    .update({
      last_sender_type: 'customer',
      last_message_at: receivedTime,
      last_message_preview: body.slice(0, 100),
      unread_count: 1, // simple v1 — increments would need a fetch-update-write cycle
    })
    .eq('id', conversationId)

  // Newsletter guard: save, but don't run Caye on it. Flag for human review.
  const newsletterReason = detectNewsletter(body, subject, fromEmail)
  if (newsletterReason) {
    await supabase
      .from('unified_conversations')
      .update({
        human_agent_enabled: true,
        human_agent_reason: `newsletter/blast detected: ${newsletterReason}`,
      })
      .eq('id', conversationId)
    console.log(`[gmail-poll] held as newsletter (${newsletterReason}) — ${fromEmail} / ${subject}`)
    return 'held'
  }

  // Historical guard: stored but not replied to
  if (isHistorical) {
    console.log(`[gmail-poll] historical message, no reply — ${fromEmail} / ${subject}`)
    return 'processed'
  }

  // No-reply / system-address guard
  const localPart = fromEmail.split('@')[0] || ''
  const NO_REPLY_LOCAL_PARTS = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|system)$/i
  if (NO_REPLY_LOCAL_PARTS.test(localPart) || /mailer-daemon|postmaster/.test(fromEmail)) {
    console.log(`[gmail-poll] No-reply address — saved but not auto-replying: ${fromEmail}`)
    return 'skipped'
  }

  // Pull system prompt for Caye's reply
  let systemPrompt =
    'You are Caye, an AI receptionist for a Caribbean small business. Reply to customer emails warmly and professionally. When in doubt, hold for the business owner.'
  const { data: aiConfig } = await supabase
    .from('workspace_ai_config')
    .select('system_prompt')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (aiConfig?.system_prompt) systemPrompt = aiConfig.system_prompt as string

  // Generate Caye's decision
  let decision
  try {
    decision = await generateCayeAutoReply(systemPrompt, {
      senderName: fromName || fromEmail,
      body: body || subject,
      channel: 'email',
      subject,
      workspaceId,
      conversationId,
      senderEmail: fromEmail,
      currentChannelMessageId: messageId,
    })
  } catch (err) {
    console.error(`[gmail-poll] Caye decision failed for ${messageId}:`, err)
    return 'error'
  }

  // Caye chose to reply → actually send via Gmail. Fall back to held-draft
  // on any send failure so the owner can still recover the conversation.
  if (decision.action === 'reply') {
    const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`
    try {
      const sent = await sendGmailReply({
        to: fromEmail,
        subject: replySubject,
        body: decision.content,
        gmailThreadId: threadId,
        conversationId,
        workspaceId,
      })
      const nowISO = new Date().toISOString()
      await supabase.from('unified_messages').insert({
        conversation_id: conversationId,
        channel_message_id: sent.gmailMessageId,
        sender_type: 'business',
        content: decision.content,
        message_type: 'text',
        sent_at: nowISO,
        status: 'sent',
        metadata: {
          subject: replySubject,
          generated_by: 'caye',
          gmail_message_id: sent.gmailMessageId,
          gmail_thread_id: sent.threadId,
          source: 'gmail',
          is_automated: true,
        },
      })
      // 2B (acknowledge-and-defer): Caye sent the customer a reply, but the
      // owner still needs to follow up — flip human_agent_enabled so the
      // operator sees it in their attention queue.
      const convoUpdate: Record<string, unknown> = {
        last_sender_type: 'business',
        last_business_sender_kind: 'caye',
        last_message_at: nowISO,
        last_message_preview: decision.content.slice(0, 100),
      }
      if (decision.needsOwnerFollowup) {
        convoUpdate.human_agent_enabled = true
        convoUpdate.human_agent_reason = decision.ownerNote || 'Caye replied but owner follow-up requested'
      }
      await supabase.from('unified_conversations').update(convoUpdate).eq('id', conversationId)

      console.log(`[gmail-poll] Replied: ${fromEmail} — gmailMsgId=${sent.gmailMessageId}`)
      return 'processed'
    } catch (err) {
      console.error(`[gmail-poll] Send failed for ${messageId}, falling back to held draft:`, err)
      // Fall through into the hold path below — owner still gets the draft.
    }
  }

  // Hold path — either Caye chose to hold, or a reply send failed.
  const proposedReply = decision.action === 'reply' ? decision.content : (decision.proposedReply ?? null)
  const reason = decision.action === 'hold'
    ? decision.reason
    : 'Gmail send failed — Caye drafted a reply for manual review'
  const note = decision.action === 'hold'
    ? decision.note
    : `Caye drafted a reply (send failed — please review and send manually):\n\n${decision.content}`

  await supabase
    .from('unified_conversations')
    .update({ human_agent_enabled: true, human_agent_reason: reason })
    .eq('id', conversationId)

  await supabase.from('unified_messages').insert({
    conversation_id: conversationId,
    channel_message_id: null,
    sender_type: 'business',
    content: note,
    message_type: 'text',
    sent_at: new Date().toISOString(),
    status: 'sent',
    is_internal: true,
    metadata: {
      generated_by: 'caye',
      hold_reason: reason,
      proposed_reply: proposedReply,
      decision_action: decision.action,
    },
  })

  const urgency = decision.action === 'hold' ? decision.urgency : undefined
  enqueueHoldPing({
    workspaceId,
    conversationId,
    contactName: fromName || fromEmail,
    reason,
    proposedReply: proposedReply ?? undefined,
    inboundBody: body || subject,
    urgency,
  }).catch(err => console.error('[gmail-poll] Hold ping enqueue failed:', err))

  console.log(`[gmail-poll] Held: ${fromEmail} — ${reason}`)
  return 'held'
}

interface PollStats {
  account: string
  fetched: number
  processed: number
  held: number
  skipped: number
  errors: number
}

async function pollAccount(supabase: Supabase, account: Account): Promise<PollStats> {
  const stats: PollStats = {
    account: String(account.channel_account_name || account.id),
    fetched: 0,
    processed: 0,
    held: 0,
    skipped: 0,
    errors: 0,
  }

  // Refresh token if needed
  let accessToken = String(account.access_token)
  if (tokenExpiresSoon(account.token_expires_at as string | null)) {
    const refreshToken = account.refresh_token as string | null
    if (!refreshToken) {
      console.error(`[gmail-poll] No refresh_token for ${stats.account} — skipping`)
      stats.errors++
      return stats
    }
    const refreshed = await refreshAccessToken(refreshToken)
    if (!refreshed) {
      console.error(`[gmail-poll] Token refresh failed for ${stats.account}`)
      stats.errors++
      return stats
    }
    accessToken = refreshed.accessToken
    await supabase
      .from('connected_accounts')
      .update({ access_token: refreshed.accessToken, token_expires_at: refreshed.expiresAt })
      .eq('id', String(account.id))
  }

  // List unread inbox messages
  const listUrl =
    `${GMAIL_API_BASE}/messages?q=${encodeURIComponent('is:unread in:inbox category:primary OR category:updates OR category:personal')}` +
    `&maxResults=${LIST_PAGE_SIZE}`

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!listRes.ok) {
    const errText = await listRes.text().catch(() => '')
    console.error(`[gmail-poll] List failed for ${stats.account} (${listRes.status}):`, errText.slice(0, 300))
    stats.errors++
    return stats
  }
  const listData = await listRes.json() as { messages?: { id: string; threadId: string }[] }
  const ids = (listData.messages || []).map(m => m.id)
  stats.fetched = ids.length

  for (const id of ids) {
    try {
      const detailRes = await fetch(`${GMAIL_API_BASE}/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!detailRes.ok) {
        console.error(`[gmail-poll] Detail fetch failed for ${id} (${detailRes.status})`)
        stats.errors++
        continue
      }
      const message = await detailRes.json() as GmailMessage
      const result = await processGmailMessage(supabase, account, message, accessToken)
      if (result === 'processed') stats.processed++
      else if (result === 'held') stats.held++
      else if (result === 'skipped') stats.skipped++
      else if (result === 'error') stats.errors++
    } catch (err) {
      console.error(`[gmail-poll] Loop error for ${id}:`, err)
      stats.errors++
    }
  }

  return stats
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const provided = req.headers.get('x-cron-secret')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()
  const { data: accounts, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('channel_type', 'gmail')
    .eq('is_active', true)

  if (error) {
    console.error('[gmail-poll] account fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const results: PollStats[] = []
  for (const account of accounts ?? []) {
    try {
      results.push(await pollAccount(supabase, account as Account))
    } catch (err) {
      console.error(`[gmail-poll] pollAccount threw for ${account.id}:`, err)
      results.push({
        account: String(account.channel_account_name || account.id),
        fetched: 0,
        processed: 0,
        held: 0,
        skipped: 0,
        errors: 1,
      })
    }
  }

  return NextResponse.json({ accounts: results.length, results })
}
