/**
 * GET /api/email/poll
 *
 * Called by an external cron (e.g. cron-job.org) every 2 minutes.
 * Fetches unread inbox messages for every active Zoho Mail account,
 * creates conversations/messages, and sends Caye AI auto-replies.
 *
 * Secure with CRON_SECRET env var — pass it as the
 * x-cron-secret header from cron-job.org.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { generateCayeAutoReply } from '@/lib/caye-reply'
import { enqueueHoldPing } from '@/lib/whatsapp/triggers'
import { applyEscalation } from '@/lib/whatsapp/escalation'
import { htmlToPlainText } from '@/lib/email-text'
import { maybeRefreshOwnerVoiceProfile } from '@/lib/owner-voice-learning'
import { detectOwnerCorrection } from '@/lib/owner-correction'
import { isNoReplySender, isCalendarInvite, isPaymentReceipt } from '@/lib/sender-classifier'
import {
  isWeb3FormsNotification,
  parseWeb3FormsFields,
  buildWeb3FormsContext,
  type Web3FormsParsed,
} from '@/lib/email/web3forms'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'

function mailBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'mail.zoho')
}

function tokenExpiresSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() < Date.now() + 5 * 60 * 1000
}

async function refreshAccessToken(
  token: string
): Promise<{ accessToken: string; expiresAt: string } | null> {
  const res = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      refresh_token: token,
    }).toString(),
  })
  const data = await res.json()
  if (!data.access_token) return null
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
  }
}

// htmlToPlainText (with CSS/script stripping + quoted-reply removal) now
// lives in @/lib/email-text — shared with the zoho-email webhook so both
// ingestion paths produce identical output.

/**
 * Fetches a message body from Zoho. Tries the folder-scoped path first
 * (the documented current API) and falls back to the legacy unscoped path.
 * Logs full diagnostics if both fail or return empty.
 */
async function fetchMessageContent(
  base: string,
  accountId: string,
  messageId: string,
  accessToken: string,
  folderId: string
): Promise<string> {
  const paths = [
    folderId ? `${base}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content` : null,
    `${base}/api/accounts/${accountId}/messages/${messageId}/content`,
  ].filter(Boolean) as string[]

  for (const url of paths) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          Accept: 'application/json',
        },
      })
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      const data = (json?.data ?? {}) as Record<string, unknown>
      const raw = String(
        data.content || data.htmlContent || data.textContent || data.summary || ''
      )
      if (!res.ok) {
        console.warn(`[email/poll] content fetch ${res.status} for ${messageId} at ${url}:`, JSON.stringify(json).slice(0, 300))
        continue
      }
      if (raw) {
        // htmlToPlainText handles plain-text input too AND strips quoted
        // reply chains — no need to branch on tag presence or post-process.
        return htmlToPlainText(raw)
      }
      console.warn(`[email/poll] content fetch returned empty for ${messageId} at ${url}; payload:`, JSON.stringify(json).slice(0, 300))
    } catch (err) {
      console.error(`[email/poll] content fetch threw for ${messageId} at ${url}:`, err)
    }
  }
  return ''
}

function extractEmail(raw: string): string {
  return (
    raw.match(/<([^>]+)>/)?.[1]?.toLowerCase().trim() ||
    raw.toLowerCase().trim()
  )
}

// Web3Forms helpers (isWeb3FormsNotification, parseWeb3FormsFields,
// buildWeb3FormsContext, Web3FormsParsed) live in lib/email/web3forms.ts —
// shared with the zoho-email webhook so both real-time push and cron poll
// resolve the form-submitted customer's identity the same way. Imported at
// the top of this file.

// ── Payment receipt helpers ─────────────────────────────────────────────────
//
// isPaymentReceipt moved to lib/sender-classifier.ts (shared with the webhook).
// Receipt field parsing + thank-you composition stay local since they're only
// used by the cron poll path.

interface ReceiptParsed {
  customerName: string
  customerEmail: string | null
  amount: string
  description: string
  approvalCode: string
  response: string
  transactionId: string
}

function matchReceiptField(body: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${escaped}:\\s*(.+)$`, 'im')
  const m = body.match(re)
  return m ? m[1].trim() : null
}

/**
 * Parses a payment processor receipt into structured fields.
 * Returns null if any required field is missing.
 * customerEmail is optional — receipts often don't include it.
 */
function parseReceiptFields(body: string): ReceiptParsed | null {
  const customerName = matchReceiptField(body, 'Customer Name')
  const amount = matchReceiptField(body, 'Total')
  const description = matchReceiptField(body, 'Description')
  const approvalCode = matchReceiptField(body, 'ApprovalCode')
  const response = matchReceiptField(body, 'Response')
  const transactionId = matchReceiptField(body, 'Transaction ID')
  if (!customerName || !amount || !description || !approvalCode || !response || !transactionId) {
    return null
  }
  const customerEmail =
    matchReceiptField(body, 'Customer Email') ||
    matchReceiptField(body, 'Email') ||
    null
  return {
    customerName,
    customerEmail: customerEmail ? customerEmail.toLowerCase() : null,
    amount,
    description,
    approvalCode,
    response,
    transactionId,
  }
}

/**
 * Builds the warm thank-you email body sent to the customer when a
 * payment is approved. Plain text, signed off as Karenda.
 */
function buildReceiptThankYou(parsed: ReceiptParsed): string {
  // Hardcoded fallback used when AI generation is disabled or no thread match.
  // Bypasses sanitizeDashes, so the copy here must already comply with the
  // no-em-dash rule. Phone numbers ordered per the workspace sign-off
  // convention (personal line first, business line second).
  return [
    `Hi ${parsed.customerName.split(/\s+/)[0]},`,
    '',
    `Thank you. Your payment of ${parsed.amount} has been received for ${parsed.description}.`,
    '',
    'Please meet us at the Resorts World Bimini tram stop. Allow 15-30 minutes before tour time.',
    '',
    'Looking forward to having you with us!',
    '',
    'Karenda',
    'Bimini Island Tours',
    '242 473 0233 · 242 814 8687 · info@tourbimini.com',
  ].join('\n')
}

/**
 * Builds the synthetic "inbound" body fed to generateCayeAutoReply when a
 * payment receipt is intercepted. This is NOT a customer message — it's a
 * system notification that tells Caye to send a payment-confirmation reply
 * in the owner's voice on the existing thread. Caye reads the thread
 * history (booking details, prior owner messages, logistics) and the voice
 * profile to compose the reply, instead of using a hardcoded template.
 */
function buildReceiptSyntheticInbound(parsed: ReceiptParsed): string {
  return [
    '[INTERNAL SYSTEM NOTIFICATION — NOT A CUSTOMER MESSAGE]',
    '',
    `The payment processor just notified us that ${parsed.customerName} paid ${parsed.amount} for: ${parsed.description}.`,
    '',
    `Transaction ID: ${parsed.transactionId}`,
    `Response: ${parsed.response}`,
    `Approval code: ${parsed.approvalCode}`,
    '',
    'TASK: send the customer a warm payment-confirmation reply on this same email thread, in the owner\'s voice. The reply should:',
    '- thank them for the payment and confirm the amount received',
    '- restate what they paid for (use the description and any specifics from the booking thread above — date, time, party size, tour name)',
    '- include the relevant meet-up logistics the owner has used before on this thread or in their voice profile (pickup location, arrival window, what to bring)',
    '- sign off the way the owner normally signs off',
    '',
    'IMPORTANT: do NOT call create_booking, check_availability, find_bookings, or any booking tool — the booking already exists and the payment is complete. Only call send_reply with the confirmation. Do not ask the customer any questions.',
  ].join('\n')
}

/**
 * Renders the receipt as an internal note that surfaces all the
 * payment details for the business owner to review in the inbox.
 */
function buildReceiptInternalNote(parsed: ReceiptParsed, customerEmailed: boolean): string {
  const lines = [
    `Payment receipt — ${parsed.response}`,
    `Customer: ${parsed.customerName}`,
    `Amount: ${parsed.amount}`,
    `Description: ${parsed.description}`,
    `Approval Code: ${parsed.approvalCode}`,
    `Transaction ID: ${parsed.transactionId}`,
  ]
  if (parsed.customerEmail) lines.push(`Customer Email: ${parsed.customerEmail}`)
  lines.push('')
  if (parsed.response.toUpperCase() !== 'APPROVED') {
    lines.push('Payment was not approved — no confirmation sent to customer.')
  } else if (customerEmailed) {
    lines.push('Confirmation email sent to customer.')
  } else {
    lines.push('No customer email on receipt — confirmation not sent automatically.')
  }
  return lines.join('\n')
}

// ── Newsletter / marketing-blast detection ──────────────────────────────────
// Catches things like the Kelsey Tonner "AI for tour operators" series before
// Caye gets a chance to reply to them. We save the inbound message (so the
// owner still sees it in the inbox) but skip the AI loop entirely and flag
// for human review. Heuristic: requires TWO strong signals to fire — this
// keeps real customer mail from getting mis-classified.

// Strong "this is a blast" signals
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

// Invisible / zero-width characters common in mailer preheader padding
const INVISIBLE_CHARS_RE = /[͏­​-‏⁠᠎﻿]/g

function detectNewsletter(body: string, subject: string, fromEmail: string): string | null {
  if (!body) return null

  const signals: string[] = []

  // Invisible/zero-width padding — count occurrences across the whole body,
  // since mailers interleave them with spaces. >=30 is well above noise floor.
  const invisibleCount = (body.match(INVISIBLE_CHARS_RE) || []).length
  if (invisibleCount >= 30) signals.push(`${invisibleCount} invisible padding chars`)

  let phraseHits = 0
  for (const re of BLAST_PHRASES) if (re.test(body)) phraseHits++
  if (phraseHits >= 2) signals.push(`${phraseHits} mass-mailer phrases`)

  // Sender heuristic: common ESP/marketing-tool envelope domains
  const fromDomain = fromEmail.split('@')[1]?.toLowerCase() || ''
  if (/\b(mailchimp|sendgrid|sparkpost|mailgun|constantcontact|hubspot|convertkit|activecampaign|mailerlite|klaviyo|emailoctopus|aweber|cmail\d+)\b/.test(fromDomain)) {
    signals.push(`ESP sender domain (${fromDomain})`)
  }

  // Two distinct signal categories → blast
  if (signals.length >= 2) return signals.join('; ')

  // Single-category fallbacks
  if (invisibleCount >= 30 && phraseHits >= 1) {
    return `${invisibleCount} invisible chars + ${phraseHits} blast phrase`
  }
  if (phraseHits >= 3) return `${phraseHits} mass-mailer phrases`

  // Subject patterns common in mailing-list weekly series
  if (/^(weekly|newsletter|digest|edition)\b/i.test(subject) && phraseHits >= 1) {
    return `newsletter-pattern subject + ${phraseHits} blast phrase`
  }

  return null
}

// ── Cold-sales pitch detection ──────────────────────────────────────────────
// Catches 1:1 cold outreach (not mass blasts — those are detectNewsletter).
// The Anastasiya Lisouskaya / Virgin Voyages partnership thread is the
// load-bearing false-positive case to avoid: cold contact + partnership
// framing + formal signature, but ZERO of the "calendly / 30-min chat /
// I help X companies" signals. Thresholds must keep her clear.
//
// Strong signals (any one is enough on its own):
//   - sender domain on a known SaaS sales-tool list
// Weak signals (need 2+ together):
//   - body phrases typical of cold pitches
//   - generic "intro" subject lines
//
// Returns a reason string when matched, null otherwise.

const COLD_SALES_TOOL_DOMAINS = /\b(apollo\.io|outreach\.io|salesloft\.com|salesloft\.io|mixmax\.com|hunter\.io|reply\.io|woodpecker\.co|lemlist\.com|mailshake\.com|saleshandy\.com|smartlead\.ai|instantly\.ai)\b/

const COLD_SALES_BODY_PHRASES: RegExp[] = [
  /\b(calendly\.com|cal\.com)\//i,
  /\b(15|20|25|30)[-\s]?(min|minute)s?\b.{0,40}\b(chat|call|demo|conversation|sync)\b/i,
  /book\s+(?:a\s+)?(?:quick\s+)?(?:time|call|chat|demo|meeting|slot)\b/i,
  /\b(i|we)\s+help\s+(tour|small|local|caribbean)?\s*(operators?|businesses?|companies?|owners?|founders?)\b/i,
  /\b(grow|scale|increase|boost|double|10x|optimi[sz]e)\s+your\s+(bookings?|revenue|business|sales|leads?)\b/i,
  /\b(saw|came across|noticed|stumbled (?:on|upon))\s+(?:your\s+)?(website|business|company|tours?|page)\b/i,
  /\bquick\s+(intro|question|favor|ask)\b/i,
  /worth\s+(?:a\s+)?(?:quick\s+)?(?:15|20|30)?\s*(?:min(?:ute)?s?\s+)?chat\b/i,
  /\b(ai|chatbot|automation|saas|crm)\s+for\s+(tour|small|local)\s+(operators?|businesses?|companies?)\b/i,
]

function detectColdSales(body: string, subject: string, fromEmail: string): string | null {
  if (!body) return null

  const signals: string[] = []

  // Strong: sender domain is a known SaaS cold-outreach platform
  const fromDomain = fromEmail.split('@')[1]?.toLowerCase() || ''
  if (COLD_SALES_TOOL_DOMAINS.test(fromDomain)) {
    signals.push(`cold-outreach tool domain (${fromDomain})`)
  }

  // Weak: body phrases. Need 2+ to fire on phrases alone.
  let phraseHits = 0
  const matchedPhrases: string[] = []
  for (const re of COLD_SALES_BODY_PHRASES) {
    const m = body.match(re)
    if (m) {
      phraseHits++
      matchedPhrases.push(m[0].slice(0, 40))
    }
  }
  if (phraseHits >= 2) {
    signals.push(`${phraseHits} cold-pitch phrases: ${matchedPhrases.slice(0, 3).join(' | ')}`)
  }

  // Subject pattern: bare "Quick intro", "Quick question", "Hi - quick chat"
  const isGenericIntroSubject = /^(re:\s*)?(hi|hello|hey)?\s*[-,:]?\s*quick\s+(intro|question|chat)/i.test(subject)
  if (isGenericIntroSubject && phraseHits >= 1) {
    return `generic intro subject + ${phraseHits} cold-pitch phrase`
  }

  if (signals.length === 0) return null
  return signals.join('; ')
}

type Supabase = ReturnType<typeof createServiceClient>
type Account = Record<string, unknown>

/**
 * Imports a sent message from the Zoho Sent folder into an existing Caye
 * conversation so the chat thread shows both sides of the exchange.
 * Only adds the message if the thread already exists — never creates new
 * conversations from sent mail.
 */
async function processSentMessage(
  supabase: Supabase,
  account: Account,
  msg: Record<string, unknown>,
  accessToken: string,
  base: string
): Promise<'processed' | 'skipped' | 'error'> {
  const messageId = String(msg.messageId || msg.message_id || '')
  if (!messageId) return 'skipped'

  // Skip if already imported
  const { data: existing } = await supabase
    .from('unified_messages')
    .select('id')
    .eq('channel_message_id', messageId)
    .maybeSingle()
  if (existing) return 'skipped'

  const threadId = String(msg.threadId || msg.thread_id || messageId)
  const sentTime = msg.sentTime || msg.receivedTime
    ? new Date(Number(msg.sentTime || msg.receivedTime)).toISOString()
    : new Date().toISOString()
  const subject = String(msg.subject || '(no subject)')
  const meta = (account.metadata || {}) as Record<string, string>
  const accountId = meta.zoho_account_id || String(account.channel_account_id)

  // Only import into threads that are already open in Caye
  const { data: conversation } = await supabase
    .from('unified_conversations')
    .select('id, last_business_sender_kind')
    .eq('connected_account_id', String(account.id))
    .eq('channel_conversation_id', threadId)
    .maybeSingle()

  if (!conversation) return 'skipped' // No matching thread — don't create one from sent mail

  // Check if this Zoho Sent message is actually a Caye send that was already
  // stored with a synthetic `caye_*` channel_message_id. Covers all known
  // Caye send-site prefixes:
  //   - caye_auto_*  (webhook auto-reply path)
  //   - caye_ack_*   (webhook hold-acknowledgement send)
  //   - caye_admin_* (admin/caye-respond-to-conversation manual trigger)
  // Match within a 5-minute window. Anthony Coll 2026-06-23 case surfaced
  // the gap — admin-endpoint sends were getting mis-attributed as human.
  const sentMs = Number(msg.sentTime || msg.receivedTime || Date.now())
  const windowStart = new Date(sentMs - 5 * 60 * 1000).toISOString()
  const windowEnd   = new Date(sentMs + 5 * 60 * 1000).toISOString()
  const { data: cayeAutoMsg } = await supabase
    .from('unified_messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'business')
    .like('channel_message_id', 'caye\\_%')
    .gte('sent_at', windowStart)
    .lte('sent_at', windowEnd)
    .maybeSingle()

  if (cayeAutoMsg) {
    // Backfill the real Zoho message ID so future polls skip it cleanly
    await supabase
      .from('unified_messages')
      .update({ channel_message_id: messageId })
      .eq('id', cayeAutoMsg.id)
    // Conversation sender_kind is already 'caye' — don't overwrite it
    return 'skipped'
  }

  // Same dedup but for human-sent replies from the dashboard:
  // messages/send writes channel_message_id='manual_<ts>' with
  // metadata.sent_by='human'. When Zoho echoes it back through the sent
  // folder a few seconds later, we'd otherwise create a duplicate row that
  // renders as a second chat bubble. Match within the same 5-min window
  // and backfill the real Zoho message ID so future polls skip cleanly.
  const { data: manualMsg } = await supabase
    .from('unified_messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'business')
    .like('channel_message_id', 'manual_%')
    .gte('sent_at', windowStart)
    .lte('sent_at', windowEnd)
    .maybeSingle()

  if (manualMsg) {
    await supabase
      .from('unified_messages')
      .update({ channel_message_id: messageId })
      .eq('id', manualMsg.id)
    return 'skipped'
  }

  const raw = await fetchMessageContent(
    base, String(accountId), messageId, accessToken,
    String(msg.folderId || msg.folder_id || '')
  )
  // fetchMessageContent already returns CSS-stripped, quote-stripped text.
  const body = raw
  if (!body) return 'skipped' // Nothing meaningful to store

  // Look at the message immediately preceding this one in the conversation.
  // If it was a Caye auto-reply (and no customer message came after it),
  // this owner reply is an override/correction — the highest-signal voice
  // training sample we can capture from a Zoho-only owner workflow.
  // Excludes internal notes (e.g. hold-for-human handoffs) from the lookup.
  const { data: priorRow } = await supabase
    .from('unified_messages')
    .select('id, sender_type, metadata')
    .eq('conversation_id', conversation.id)
    .eq('is_internal', false)
    .lt('sent_at', sentTime)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const correction = detectOwnerCorrection(
    priorRow
      ? {
          id: priorRow.id,
          sender_type: priorRow.sender_type as 'customer' | 'business',
          metadata: priorRow.metadata as Record<string, unknown> | null,
        }
      : null
  )

  const ownerMetadata: Record<string, unknown> = {
    subject,
    zoho_message_id: messageId,
    zoho_thread_id: threadId,
    source: 'zoho_sent',
    // sent_by='human' makes this row eligible as a voice-learning sample.
    // The owner-voice-learning filter rejects rows without this flag so it
    // can distinguish owner replies from Caye auto-replies.
    sent_by: 'human',
  }
  if (correction.is_correction) {
    ownerMetadata.is_correction = true
    ownerMetadata.corrected_caye_message_id = correction.corrected_caye_message_id
  }

  const { error } = await supabase.from('unified_messages').insert({
    conversation_id: conversation.id,
    channel_message_id: messageId,
    sender_type: 'business',
    content: body,
    message_type: 'text',
    sent_at: sentTime,
    status: 'sent',
    metadata: ownerMetadata,
  })
  if (error) {
    console.error('[email/poll] Sent message insert failed:', error)
    return 'error'
  }

  // Update conversation:
  // - Refresh preview/sender so the inbox renders correctly
  // - Clear the human_agent_enabled hold flag: the owner has now responded,
  //   so Caye should resume monitoring (she will re-evaluate on the customer's
  //   next message and re-hold if still uncertain).
  await supabase
    .from('unified_conversations')
    .update({
      last_sender_type: 'business',
      last_business_sender_kind: 'human',
      last_message_at: sentTime,
      last_message_preview: body.slice(0, 100),
      human_agent_enabled: false,
      human_agent_reason: null,
    })
    .eq('id', conversation.id)

  // Fire-and-forget owner voice learning. Identical to the in-app send path
  // — re-extracts the voice profile every REFRESH_EVERY trusted-channel
  // owner messages. Without this, Karenda's Zoho-direct replies never train
  // the voice profile because she rarely uses the app.
  maybeRefreshOwnerVoiceProfile(String(account.user_id), 'email').catch(err =>
    console.error('[email/poll] Owner voice refresh failed:', err)
  )

  if (correction.is_correction) {
    console.log(
      `[email/poll] Owner correction detected on conv ${conversation.id} ` +
        `(overrode Caye message ${correction.corrected_caye_message_id})`
    )
  }

  return 'processed'
}

async function processMessage(
  supabase: Supabase,
  account: Account,
  msg: Record<string, unknown>,
  accessToken: string,
  base: string
): Promise<'processed' | 'skipped' | 'error' | 'held'> {
  const messageId = String(msg.messageId || msg.message_id || '')
  if (!messageId) return 'skipped'

  // Skip if already processed
  const { data: existing } = await supabase
    .from('unified_messages')
    .select('id')
    .eq('channel_message_id', messageId)
    .maybeSingle()
  if (existing) return 'skipped'

  const fromRaw = String(msg.fromAddress || msg.from_address || '')
  const fromEmail = extractEmail(fromRaw)
  const fromName = String(msg.fromDisplayName || msg.sender || fromRaw)
  const subject = String(msg.subject || '(no subject)')
  const receivedTime = msg.receivedTime
    ? new Date(Number(msg.receivedTime)).toISOString()
    : new Date().toISOString()
  const threadId = String(msg.threadId || msg.thread_id || messageId)
  const workspaceId = String(account.user_id)
  const ownEmail = String(account.channel_account_name || '').toLowerCase().trim()
  const meta = (account.metadata || {}) as Record<string, string>
  const accountId = meta.zoho_account_id || String(account.channel_account_id)

  // Self-loop guard
  if (!fromEmail || fromEmail === ownEmail) return 'skipped'

  // ── Web3Forms interception ────────────────────────────────────────────────
  // Web3Forms sends a notification to the business inbox — the From: address
  // is noreply@web3forms.com, not the customer. We need to extract the real
  // customer contact from the email body and redirect accordingly.
  let web3FormsFields: Web3FormsParsed | null = null
  if (isWeb3FormsNotification(fromEmail)) {
    // Fetch body early so we can parse the fields
    const w3Body = await fetchMessageContent(
      base,
      String(accountId),
      messageId,
      accessToken,
      String(msg.folderId || msg.folder_id || '')
    )

    web3FormsFields = parseWeb3FormsFields(w3Body)

    if (!web3FormsFields) {
      // Couldn't extract structured customer fields — fall through and save the raw
      // email as a regular inbound message. Better to surface it than drop it.
      console.warn(`[email/poll] Web3Forms parse failed, saving as raw email: ${messageId}`)
    }
  }

  // ── Payment receipt interception ──────────────────────────────────────────
  // Karenda's payment processor sends a receipt to the business inbox. We
  // detect it, never reply to the processor, and send the customer a
  // thank-you confirmation only when the payment is APPROVED. Failed/declined
  // receipts become internal notes for Karenda to review.
  const isReceiptCandidate =
    /receipt/i.test(subject) || /chargeanywhere\.com/i.test(fromRaw)
  if (!web3FormsFields && isReceiptCandidate) {
    const rBody = await fetchMessageContent(
      base,
      String(accountId),
      messageId,
      accessToken,
      String(msg.folderId || msg.folder_id || '')
    )

    if (isPaymentReceipt(subject, rBody)) {
      const receipt = parseReceiptFields(rBody)
      if (!receipt) {
        console.warn(`[email/poll] Receipt parse failed, saving as raw email: ${messageId}`)
      } else {
        const approved = receipt.response.toUpperCase() === 'APPROVED'

        // Receipts from chargeanywhere sometimes carry the merchant's own
        // email in the "Customer Email" field (in-person sales, or when the
        // merchant's address is the default on the terminal). Treat that as
        // "no customer email" so we don't create / match a phantom Karenda-as-
        // customer conversation. 70+ such rows accumulated before this guard.
        let customerEmail = receipt.customerEmail
        if (customerEmail && customerEmail.toLowerCase().trim() === ownEmail) {
          console.log(`[email/poll] Receipt customer email matches own (${ownEmail}) — treating as no customer email`)
          customerEmail = null
        }

        // Promote any matching pending booking to confirmed. This closes the
        // payment-side of the booking state machine: Caye creates bookings as
        // pending when the customer agrees, and only the payment receipt
        // moves them to confirmed. Without this, paid bookings would sit at
        // pending forever (until the auto-complete sweep flips them to
        // completed, which mis-encodes "happened" as "happened-and-paid").
        // Match logic: same workspace, same customer email, status=pending.
        // When multiple candidates exist (rare — same customer with multiple
        // pending bookings), pick the one whose booking_date is closest to
        // today and in the future. Idempotent: only updates pending rows, so
        // re-running on the same receipt is a no-op once promoted.
        if (approved && customerEmail) {
          const { data: candidateBookings } = await supabase
            .from('bookings')
            .select('id, booking_date, customer_name, notes')
            .eq('user_id', workspaceId)
            .eq('status', 'pending')
            .ilike('customer_email', customerEmail)
          if (candidateBookings && candidateBookings.length > 0) {
            const todayISO = new Date().toISOString().slice(0, 10)
            const future = candidateBookings
              .filter(b => b.booking_date >= todayISO)
              .sort((a, b) => a.booking_date.localeCompare(b.booking_date))
            const promote = future[0] ?? candidateBookings[0]
            const stamp =
              `\n\n[Caye payment promotion ${new Date().toISOString().slice(0, 10)}] ` +
              `Receipt ${receipt.transactionId} (${receipt.amount} ${receipt.response}). ` +
              `Status: pending → confirmed.`
            const { error: promoteErr } = await supabase
              .from('bookings')
              .update({
                status: 'confirmed',
                notes: (promote.notes ?? '') + stamp,
                updated_at: new Date().toISOString(),
              })
              .eq('id', promote.id)
              .eq('status', 'pending')
            if (promoteErr) {
              console.error('[email/poll] Booking promotion failed:', promoteErr, { bookingId: promote.id })
            } else {
              console.log(
                `[email/poll] Booking promoted to confirmed: ${promote.id} ` +
                `(${promote.customer_name}, ${promote.booking_date}, tx ${receipt.transactionId})`
              )
            }
          } else {
            console.log(`[email/poll] Receipt for ${customerEmail} — no pending booking matched, skipping promotion`)
          }
        }

        // Find the customer's existing conversation. Prefer email match;
        // fall back to a name match scoped to this account. Track whether
        // we matched an existing thread vs. had to fabricate a receipt-only
        // conversation — only matched threads have the booking history that
        // lets Caye generate a properly contextual confirmation.
        let conversationId: string | null = null
        let conversationMatched = false
        if (customerEmail) {
          const { data: byEmail } = await supabase
            .from('unified_conversations')
            .select('id')
            .eq('connected_account_id', String(account.id))
            .eq('customer_id', customerEmail)
            .order('last_message_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (byEmail) {
            conversationId = String(byEmail.id)
            conversationMatched = true
          }
        }
        if (!conversationId) {
          const { data: byName } = await supabase
            .from('unified_conversations')
            .select('id')
            .eq('connected_account_id', String(account.id))
            .ilike('customer_name', receipt.customerName)
            .order('last_message_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          if (byName) {
            conversationId = String(byName.id)
            conversationMatched = true
          }
        }

        // No existing conversation — create one keyed by the transaction ID
        // so the receipt still surfaces in Karenda's inbox.
        if (!conversationId) {
          const { data: created, error: createErr } = await supabase
            .from('unified_conversations')
            .upsert(
              {
                connected_account_id: String(account.id),
                channel_type: 'email',
                channel_conversation_id: `receipt_${receipt.transactionId}`,
                customer_name: receipt.customerName,
                customer_id: customerEmail ?? `receipt_${receipt.transactionId}`,
                status: 'open',
                metadata: {
                  subject,
                  from: fromRaw,
                  thread_id: threadId,
                  source: 'payment_receipt',
                  receipt,
                },
              },
              { onConflict: 'connected_account_id,channel_conversation_id' }
            )
            .select('id')
            .single()
          if (createErr || !created) {
            console.error('[email/poll] Receipt conversation upsert failed:', createErr)
            return 'error'
          }
          conversationId = String(created.id)
        }

        let customerEmailed = false

        // Send thank-you only when approved AND we have a customer email.
        // Generate the body via generateCayeAutoReply when we have a matched
        // thread — Caye reads the booking history + voice profile and writes
        // the confirmation in the owner's voice. Falls back to the template
        // when the LLM call fails or no thread context exists (receipt-only
        // synthetic conversation).
        if (approved && customerEmail) {
          let thankYou: string = buildReceiptThankYou(receipt)
          let proposedReplyForHold: string | undefined
          let shouldSend = true

          if (conversationMatched) {
            // Load workspace AI prompt for the Caye-voiced confirmation.
            let receiptSystemPrompt =
              'You are Caye, an AI receptionist for a Caribbean small business. Reply to customer emails warmly and professionally. When in doubt, hold for the business owner.'
            const { data: receiptAiConfig } = await supabase
              .from('workspace_ai_config')
              .select('system_prompt, ai_enabled')
              .eq('workspace_id', workspaceId)
              .maybeSingle()
            if (receiptAiConfig?.system_prompt) receiptSystemPrompt = receiptAiConfig.system_prompt

            if (receiptAiConfig?.ai_enabled === false) {
              // AI disabled — fall back to template send so receipts still confirm.
              console.log(`[email/poll] AI disabled — receipt using template fallback`)
            } else {
              try {
                let decision = await generateCayeAutoReply(
                  receiptSystemPrompt,
                  {
                    senderName: receipt.customerName,
                    body: buildReceiptSyntheticInbound(receipt),
                    channel: 'email',
                    subject: `Payment received — ${receipt.description}`,
                    workspaceId,
                    conversationId,
                    senderEmail: customerEmail,
                  }
                )
                decision = await applyEscalation(decision, {
                  workspaceId,
                  conversationId,
                  contactName: receipt.customerName,
                })
                if (decision.action === 'reply') {
                  thankYou = decision.content
                } else {
                  // Caye chose to hold (owner just replied, identity-guard
                  // flagged something, etc.). Don't send — surface the
                  // proposed draft as an internal note so Karenda can review.
                  shouldSend = false
                  proposedReplyForHold = decision.proposedReply
                  console.log(
                    `[email/poll] Receipt held by Caye: ${decision.reason}`
                  )
                }
              } catch (err) {
                console.error(
                  '[email/poll] Receipt AI reply failed, falling back to template:',
                  err
                )
                // thankYou already set to template above
              }
            }
          }

          const replySubject = `Payment received — ${receipt.description}`

          if (shouldSend) {
            const sendRes = await fetch(`${base}/api/accounts/${accountId}/messages`, {
              method: 'POST',
              headers: {
                Authorization: `Zoho-oauthtoken ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                fromAddress: ownEmail,
                toAddress: customerEmail,
                subject: replySubject,
                content: thankYou,
                mailFormat: 'plaintext',
              }),
            })
            const sendData = await sendRes.json()
            const code = sendData.status?.code
            if (!sendRes.ok || (code !== 200 && code !== 201)) {
              console.error('[email/poll] Receipt thank-you send failed:', sendData)
            } else {
              customerEmailed = true
              const sentAt = new Date().toISOString()
              await supabase.from('unified_messages').insert({
                conversation_id: conversationId,
                channel_message_id: `caye_receipt_${receipt.transactionId}`,
                sender_type: 'business',
                content: thankYou,
                message_type: 'text',
                sent_at: sentAt,
                status: 'sent',
                metadata: {
                  subject: replySubject,
                  is_automated: true,
                  generated_by: 'caye',
                  source: 'payment_receipt',
                  transaction_id: receipt.transactionId,
                },
              })
              await supabase
                .from('unified_conversations')
                .update({
                  last_sender_type: 'business',
                  last_business_sender_kind: 'caye',
                  last_message_at: sentAt,
                  last_message_preview: thankYou.slice(0, 100),
                })
                .eq('id', conversationId)
            }
          } else {
            // Held — post the proposed draft as an internal message for
            // Karenda to review/send.
            await supabase.from('unified_messages').insert({
              conversation_id: conversationId,
              channel_message_id: `caye_receipt_hold_${receipt.transactionId}`,
              sender_type: 'business',
              content: `Payment confirmation held for owner review.`,
              message_type: 'text',
              sent_at: new Date().toISOString(),
              status: 'sent',
              is_internal: true,
              metadata: {
                generated_by: 'caye',
                source: 'payment_receipt',
                transaction_id: receipt.transactionId,
                proposed_reply: proposedReplyForHold ?? buildReceiptThankYou(receipt),
              },
            })
          }
        }

        // Internal note so Karenda sees the receipt in the inbox
        const note = buildReceiptInternalNote(receipt, customerEmailed)
        await supabase.from('unified_messages').insert({
          conversation_id: conversationId,
          channel_message_id: `receipt_note_${receipt.transactionId}`,
          sender_type: 'business',
          content: note,
          message_type: 'text',
          sent_at: receivedTime,
          status: 'sent',
          is_internal: true,
          metadata: {
            source: 'payment_receipt',
            response: receipt.response,
            transaction_id: receipt.transactionId,
            zoho_message_id: messageId,
          },
        })

        console.log(
          `[email/poll] Receipt processed: ${receipt.response} for ${receipt.customerName} (tx ${receipt.transactionId}, emailed=${customerEmailed})`
        )
        return 'processed'
      }
    }
  }

  // Resolve the effective contact for this message
  const effectiveEmail = web3FormsFields?.customerEmail ?? fromEmail
  const effectiveName  = web3FormsFields?.customerName  ?? fromName

  // If the effective sender is a noreply/vendor address (Zoho calendar
  // invites, chargeanywhere automation, mailer-daemon bounces, etc.), still
  // save the message for audit but create the conversation pre-archived so
  // it doesn't appear in Karenda's default inbox view. The auto-reply gate
  // downstream uses a wider regex (also catches role addresses like info@,
  // support@) — see lib/sender-classifier.ts for the distinction. Web3Forms
  // is excluded by the use of effectiveEmail (which is the parsed customer,
  // not noreply@web3forms.com).
  //
  // We extend this to also pre-archive calendar invites — those come from
  // real human senders so isNoReplySender misses them, but they're not
  // customer conversations. The check needs the body, so we recompute below
  // after the body fetch.
  let archiveOnCreate = isNoReplySender(effectiveEmail)

  // Only auto-reply to emails that arrived after the account was connected.
  // Historical emails are imported into the chat but never replied to.
  const accountConnectedAt = String(account.updated_at || account.created_at || '')
  const isHistorical = accountConnectedAt
    ? new Date(receivedTime).getTime() < new Date(accountConnectedAt).getTime()
    : false

  // Fetch full message body (skip if already fetched during Web3Forms parsing)
  let body: string
  if (web3FormsFields) {
    // Body was already fetched above; rebuild context from structured fields
    body = buildWeb3FormsContext(web3FormsFields)
  } else {
    // fetchMessageContent already returns CSS-stripped, quote-stripped text
    // via lib/email-text — no further post-processing needed.
    body = await fetchMessageContent(base, String(accountId), messageId, accessToken, String(msg.folderId || msg.folder_id || ''))
  }

  // Calendar-invite check — body-dependent so it runs after the body fetch.
  // Catches Google Calendar / Outlook / iCal invitations and cancellations
  // from real human senders that isNoReplySender misses (the Valeriia
  // Berezhna 2026-05-21 case dropped 4 ATS meeting-invite conversations
  // into the inbox before this guard existed).
  if (!web3FormsFields && !archiveOnCreate && isCalendarInvite(subject, body)) {
    archiveOnCreate = true
  }

  // Guard against empty-body phantom messages. Zoho occasionally exposes
  // thread artifacts (system metadata, multipart fragments, calendar
  // notifications stripped of body content) as separate messageIds with no
  // extractable body. The previous `content: body || subject` fallback
  // persisted each as a subject-only row — the Valeriia 2026-05-24 case
  // landed 6 such rows within 4ms (see Clients/bimini-island-tours.md).
  // Skip persistence: the operator can read the raw artifact in Zoho if
  // needed; nothing actionable lives in a body-less message.
  if (!web3FormsFields && (!body || body.trim().length === 0)) {
    console.log(`[email/poll] Empty body for message ${messageId} (subject="${subject}") — skipping persistence`)
    return 'skipped'
  }

  // Fetch workspace AI prompt
  let systemPrompt =
    'You are Caye, an AI receptionist for a Caribbean small business. Reply to customer emails warmly and professionally. When in doubt, hold for the business owner.'
  const { data: aiConfig } = await supabase
    .from('workspace_ai_config')
    .select('system_prompt, ai_enabled')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (aiConfig?.system_prompt) systemPrompt = aiConfig.system_prompt

  // Find-or-create conversation by customer email (NOT by threadId).
  //
  // The previous `w3f_${email}_${threadId}` prefix was a half-attempt at
  // deduping web3forms submissions with direct replies, but still produced
  // N conversations for one customer when different threadIds appeared
  // (multiple form submissions, direct reply on a new thread, Caye outbound
  // starting a new thread). The Stallings 2026-05-29 case had 3 rows for
  // jdstallings@protonmail.com. See Clients/bimini-island-tours.md.
  //
  // Rule: one conversation per (connected_account, email). Track the new
  // threadId in metadata.related_thread_ids so we keep audit trail.
  let conversation: { id: string }
  const { data: existingConv } = await supabase
    .from('unified_conversations')
    .select('id, metadata')
    .eq('connected_account_id', String(account.id))
    .eq('channel_type', 'email')
    .eq('customer_id', effectiveEmail)
    .maybeSingle()

  if (existingConv) {
    const existingMeta = (existingConv.metadata ?? {}) as Record<string, unknown>
    const existingThreads = (existingMeta.related_thread_ids as string[] | undefined) ?? [existingMeta.thread_id as string | undefined].filter(Boolean) as string[]
    const relatedThreads = Array.from(new Set([...existingThreads, threadId]))
    await supabase
      .from('unified_conversations')
      .update({
        metadata: {
          ...existingMeta,
          subject: existingMeta.subject ?? subject,
          from: existingMeta.from ?? (web3FormsFields ? effectiveEmail : fromRaw),
          thread_id: existingMeta.thread_id ?? threadId,
          related_thread_ids: relatedThreads,
          ...(web3FormsFields && !existingMeta.form_fields
            ? { source: 'web3forms', form_fields: web3FormsFields }
            : {}),
        },
      })
      .eq('id', existingConv.id)
    conversation = { id: existingConv.id }
  } else {
    const { data: created, error: convErr } = await supabase
      .from('unified_conversations')
      .insert({
        connected_account_id: String(account.id),
        channel_type: 'email',
        channel_conversation_id: threadId,
        customer_name: effectiveName,
        customer_id: effectiveEmail,
        is_archived: archiveOnCreate,
        status: 'open',
        metadata: {
          subject,
          from: web3FormsFields ? effectiveEmail : fromRaw,
          thread_id: threadId,
          related_thread_ids: [threadId],
          ...(web3FormsFields ? { source: 'web3forms', form_fields: web3FormsFields } : {}),
        },
      })
      .select('id')
      .single()

    if (convErr || !created) {
      console.error('[email/poll] Conversation insert failed:', convErr)
      return 'error'
    }
    conversation = created
  }

  // Insert inbound message — surface failures, since a silent trigger error
  // here previously caused empty conversations
  const { error: inboundErr } = await supabase.from('unified_messages').insert({
    conversation_id: conversation.id,
    channel_message_id: messageId,
    sender_type: 'customer',
    content: body || subject,
    message_type: 'text',
    sent_at: receivedTime,
    status: 'delivered',
    metadata: { subject, from: fromRaw, zoho_message_id: messageId, zoho_thread_id: threadId },
  })
  if (inboundErr) {
    console.error('[email/poll] Inbound message insert failed:', inboundErr, { messageId, conversationId: conversation.id })
    return 'error'
  }

  await supabase
    .from('unified_conversations')
    .update({ last_sender_type: 'customer', last_message_at: receivedTime, last_message_preview: (body || subject).slice(0, 100) })
    .eq('id', conversation.id)

  // ── Newsletter / marketing-blast filter ───────────────────────────────────
  // Skip the AI loop for mailing-list content but keep it visible in the inbox
  // with an internal note so the owner can audit and unsubscribe if they want.
  if (!web3FormsFields) {
    const newsletterReason = detectNewsletter(body, subject, fromEmail)
    if (newsletterReason) {
      await supabase
        .from('unified_conversations')
        .update({ human_agent_enabled: true, human_agent_reason: 'Newsletter / marketing blast — held automatically' })
        .eq('id', conversation.id)
      await supabase.from('unified_messages').insert({
        conversation_id: conversation.id,
        channel_message_id: null,
        sender_type: 'business',
        content:
          `Marketing/newsletter detected — auto-reply skipped.\n\nSignals: ${newsletterReason}\n\n` +
          `If you want Caye to stop seeing future emails from this sender, drag the thread out of Inbox in Zoho.`,
        message_type: 'text',
        sent_at: new Date().toISOString(),
        status: 'sent',
        is_internal: true,
        metadata: { generated_by: 'caye', hold_reason: 'newsletter', signals: newsletterReason, from: fromRaw },
      })
      console.log(`[email/poll] Newsletter held: ${fromEmail} — ${newsletterReason}`)
      return 'held'
    }
  }

  // ── Cold sales pitch filter ───────────────────────────────────────────────
  // 1:1 cold outreach (not mass blasts). Same skip semantics as newsletter:
  // saved, visible, held for Karenda to triage, no auto-reply. Flagged with
  // metadata.cold_sales_suspected=true so we can audit false-positive rate
  // over the next 30 days and decide whether to escalate to auto-archive.
  if (!web3FormsFields) {
    const coldSalesReason = detectColdSales(body, subject, fromEmail)
    if (coldSalesReason) {
      await supabase
        .from('unified_conversations')
        .update({
          human_agent_enabled: true,
          human_agent_reason: 'Cold sales pitch suspected — held for triage',
        })
        .eq('id', conversation.id)
      await supabase.from('unified_messages').insert({
        conversation_id: conversation.id,
        channel_message_id: null,
        sender_type: 'business',
        content:
          `Cold sales pitch suspected — auto-reply skipped.\n\nSignals: ${coldSalesReason}\n\n` +
          `Caye held this for you to decide. If it turns out to be a real partnership lead, ` +
          `just reply manually and Caye will re-engage on the next inbound. If you want her to ` +
          `stop seeing future emails from this sender, drag the thread out of Inbox in Zoho.`,
        message_type: 'text',
        sent_at: new Date().toISOString(),
        status: 'sent',
        is_internal: true,
        metadata: {
          generated_by: 'caye',
          hold_reason: 'cold_sales',
          cold_sales_suspected: true,
          signals: coldSalesReason,
          from: fromRaw,
        },
      })
      console.log(`[email/poll] Cold sales held: ${fromEmail} — ${coldSalesReason}`)
      return 'held'
    }
  }

  // Don't auto-reply to emails that existed before the account was connected
  if (isHistorical) {
    console.log(`[email/poll] Historical email skipped (no auto-reply): ${messageId}`)
    return 'skipped'
  }

  if (aiConfig?.ai_enabled === false) {
    console.log(`[email/poll] AI disabled for workspace ${workspaceId} — skipping auto-reply`)
    return 'skipped'
  }

  // Active-operator guard: if the owner has manually replied on this thread
  // recently (typed directly in Zoho, not through Caye UI), they're actively
  // engaged. Caye holds instead of autopiloting to avoid sending a competing
  // or contradictory reply on top of their work. The owner can resume Caye's
  // autopilot by clearing the held state in the UI, OR after a quiet period
  // (no human activity in HUMAN_ACTIVE_WINDOW_MS), Caye re-engages on her own.
  //
  // Surfaced 2026-05-30 from the data review: 95 human_via_external sends
  // vs 16 caye_autopilot — without this gate, Caye and Karenda race on
  // every conversation Karenda touches in Zoho.
  const HUMAN_ACTIVE_WINDOW_MS = 60 * 60 * 1000 // 60 minutes
  const { data: lastBizMsg } = await supabase
    .from('unified_messages')
    .select('sent_at, metadata, sender_attribution')
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'business')
    .eq('is_internal', false)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lastBizMsg) {
    const lastMeta = (lastBizMsg.metadata ?? {}) as Record<string, unknown>
    const isHumanLast =
      lastBizMsg.sender_attribution === 'human_via_external' ||
      lastBizMsg.sender_attribution === 'human_via_caye' ||
      lastMeta.sent_by === 'human' ||
      lastMeta.source === 'zoho_sent'
    const ageMs = Date.now() - new Date(lastBizMsg.sent_at).getTime()
    if (isHumanLast && ageMs < HUMAN_ACTIVE_WINDOW_MS) {
      const ageMin = Math.round(ageMs / 60000)
      await supabase
        .from('unified_conversations')
        .update({
          human_agent_enabled: true,
          human_agent_reason: `Owner replied directly ${ageMin}m ago — Caye paused on this thread`,
        })
        .eq('id', conversation.id)
      console.log(
        `[email/poll] Skipping autopilot — owner active on this thread ` +
        `(last human reply ${ageMin}m ago, within ${HUMAN_ACTIVE_WINDOW_MS / 60000}m window)`
      )
      return 'skipped'
    }
  }

  // Never auto-reply to vendor/system/role addresses (noreply@, mailer-daemon@,
  // info@, support@, etc.). Intentionally wider than the isNoReplySender
  // helper used for auto-archive — auto-archiving role addresses (info@,
  // support@) would hide legitimate prospects emailing from their generic
  // inbox, but auto-replying to them is still a bad idea.
  // For Web3Forms specifically we use effectiveEmail (the real customer) instead.
  const replyTarget = (web3FormsFields ? effectiveEmail : fromEmail).toLowerCase()
  const localPart = replyTarget.split('@')[0] || ''
  const NO_REPLY_LOCAL_PARTS = /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|system|support|info|admin|root)$/i
  const NO_REPLY_DOMAIN_KEYWORDS = ['mailer-daemon', 'postmaster']
  if (
    NO_REPLY_LOCAL_PARTS.test(localPart) ||
    NO_REPLY_DOMAIN_KEYWORDS.some(k => replyTarget.includes(k))
  ) {
    console.log(`[email/poll] No-reply/system address — saved but not auto-replying: ${replyTarget}`)
    return 'skipped'
  }

  // Generate Caye response
  let decision: Awaited<ReturnType<typeof generateCayeAutoReply>>
  try {
    decision = await generateCayeAutoReply(
      systemPrompt,
      {
        senderName: effectiveName || effectiveEmail,
        body: body || subject,
        channel: 'email',
        subject,
        workspaceId,
        conversationId: conversation.id,
        senderEmail: effectiveEmail,
      }
    )
  } catch (err) {
    console.error('[email/poll] AI reply generation failed:', err)
    return 'error'
  }

  decision = await applyEscalation(decision, {
    workspaceId,
    conversationId: conversation.id,
    contactName: effectiveName || effectiveEmail,
  })

  if (decision.action === 'hold') {
    await supabase
      .from('unified_conversations')
      .update({ human_agent_enabled: true, human_agent_reason: decision.reason })
      .eq('id', conversation.id)
    await supabase.from('unified_messages').insert({
      conversation_id: conversation.id,
      channel_message_id: null,
      sender_type: 'business',
      content: decision.note,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      status: 'sent',
      is_internal: true,
      metadata: {
        generated_by: 'caye',
        hold_reason: decision.reason,
        proposed_reply: decision.proposedReply ?? null,
      },
    })
    console.log(`[email/poll] Held for human: ${effectiveEmail} — ${decision.reason}`)
    enqueueHoldPing({
      workspaceId,
      conversationId: conversation.id,
      contactName: effectiveName || effectiveEmail,
      reason: decision.reason,
      proposedReply: decision.proposedReply,
      inboundBody: body || subject,
      urgency: decision.urgency,
    }).catch((err) => console.error('[email/poll] enqueueHoldPing failed:', err))
    return 'held'
  }

  // Send reply via Zoho Mail API
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`
  const sendRes = await fetch(`${base}/api/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fromAddress: ownEmail,
      toAddress: effectiveEmail,
      subject: replySubject,
      content: decision.content,
      mailFormat: 'plaintext',
    }),
  })
  const sendData = await sendRes.json()
  const code = sendData.status?.code
  if (!sendRes.ok || (code !== 200 && code !== 201)) {
    console.error('[email/poll] Send failed:', sendData)
    return 'error'
  }

  // Store outbound message
  const replySentAt = new Date().toISOString()
  const { error: outboundErr } = await supabase.from('unified_messages').insert({
    conversation_id: conversation.id,
    channel_message_id: `caye_auto_${Date.now()}`,
    sender_type: 'business',
    content: decision.content,
    message_type: 'text',
    sent_at: replySentAt,
    status: 'sent',
    metadata: { subject: replySubject, is_automated: true, generated_by: 'caye' },
  })

  if (!outboundErr) {
    await supabase
      .from('unified_conversations')
      .update({ last_sender_type: 'business', last_business_sender_kind: 'caye', last_message_at: replySentAt, last_message_preview: decision.content.slice(0, 100) })
      .eq('id', conversation.id)
  }

  console.log(`[email/poll] Auto-replied to ${effectiveEmail} for workspace ${workspaceId}`)
  return 'processed'
}

export async function GET(req: NextRequest) {
  // Verify cron secret
  const secret = process.env.CRON_SECRET
  if (secret) {
    const provided =
      req.headers.get('x-cron-secret') ||
      req.headers.get('authorization')?.replace('Bearer ', '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()

  const { data: accounts, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('channel_type', 'email')
    .eq('is_active', true)

  if (error || !accounts?.length) {
    return NextResponse.json({ accounts: 0, processed: 0, skipped: 0, errors: 0 })
  }

  const summary = { accounts: accounts.length, processed: 0, skipped: 0, errors: 0, detail: [] as string[] }

  for (const account of accounts) {
    try {
      const meta = (account.metadata || {}) as Record<string, string>
      const base = mailBase(meta.zoho_api_domain || 'https://www.zohoapis.com')
      const accountId = meta.zoho_account_id || account.channel_account_id

      // Refresh token if expiring soon
      let accessToken: string = account.access_token
      if (tokenExpiresSoon(account.token_expires_at)) {
        if (!account.refresh_token) { summary.errors++; continue }
        const refreshed = await refreshAccessToken(account.refresh_token)
        if (!refreshed) { summary.errors++; continue }
        accessToken = refreshed.accessToken
        await supabase
          .from('connected_accounts')
          .update({ access_token: refreshed.accessToken, token_expires_at: refreshed.expiresAt })
          .eq('id', account.id)
      }

      // Inbox-only polling for inbound mail. Everything else (Spam, Snoozed,
      // Archive, and the business owner's custom filing folders like
      // "Completed Tours", "Shark Lab", "Virgin", "NewsLetter") is mail that's
      // either filtered noise or already been handled. Treating Inbox as
      // Caye's queue gives the owner a manual escape hatch — drag anything
      // out of Inbox to make Caye stop engaging with it.
      const foldersRes = await fetch(
        `${base}/api/accounts/${accountId}/folders`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
      )
      const foldersData = await foldersRes.json() as { data?: { folderId: string; folderName: string; folderType?: string }[] }
      const allFolders = foldersData?.data ?? []
      const pollFolders = allFolders.filter(f => f.folderType === 'Inbox' && /^inbox$/i.test(f.folderName))
      const sentFolders = allFolders.filter(f => f.folderType === 'Sent')

      // Surface folder-list failures in the summary so silent token/permission
      // errors don't masquerade as a healthy poll.
      ;(summary.detail as string[]).push(
        `account=${accountId} folders_http=${foldersRes.status} all=${allFolders.length} poll=${pollFolders.length} sent=${sentFolders.length}`
      )
      if (!foldersRes.ok) {
        console.error(`[email/poll] Folders list failed for ${accountId}: HTTP ${foldersRes.status}`, JSON.stringify(foldersData).slice(0, 400))
        ;(summary.detail as string[]).push(
          `account=${accountId} folders_error=${JSON.stringify(foldersData).slice(0, 300)}`
        )
        summary.errors++
        continue
      }

      if (!pollFolders.length) {
        console.warn(`[email/poll] No pollable folders for account ${accountId}`)
        summary.errors++
        continue
      }

      // Only poll messages from the last 30 days — prevents flooding the inbox with
      // historical emails from archive/operational folders (Completed Tours, etc.).
      // NOTE: Zoho's messages/view endpoint rejects a `fromDate` query param
      // (EXTRA_PARAM_FOUND), so we filter client-side using msg.receivedTime.
      const fromDateMs = Date.now() - 30 * 24 * 60 * 60 * 1000

      for (const folder of pollFolders) {
        // Higher limit so high-volume folders (Notifications, etc.) don't drop new
        // messages between polls
        const listUrl = `${base}/api/accounts/${accountId}/messages/view?limit=100&folderId=${folder.folderId}`
        const listRes = await fetch(listUrl, {
          headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        })
        const listData = await listRes.json()
        const messages: Record<string, unknown>[] = Array.isArray(listData?.data) ? listData.data : []
        const zohoStatus = listData?.status?.code ?? listData?.status
        const detail = `account=${accountId} folder=${folder.folderName}(${folder.folderId}) type=${folder.folderType} http=${listRes.status} messages=${messages.length} zohoStatus=${zohoStatus}`
        console.log(`[email/poll] ${detail}`)
        ;(summary.detail as string[]).push(detail)
        if (!listRes.ok) {
          console.error(`[email/poll] Messages list failed for folder ${folder.folderName}: HTTP ${listRes.status}`, JSON.stringify(listData).slice(0, 400))
          ;(summary.detail as string[]).push(
            `account=${accountId} folder=${folder.folderName} list_error=${JSON.stringify(listData).slice(0, 300)}`
          )
          summary.errors++
          continue
        }

        // Client-side 30-day filter (Zoho doesn't accept a fromDate query param)
        const recent = messages.filter(m => {
          const t = Number(m.receivedTime ?? m.sentTime ?? 0)
          return !t || t >= fromDateMs
        })

        for (const msg of recent) {
          // Ensure folderId is on the message so processMessage can use it for content fetch
          if (!msg.folderId && !msg.folder_id) msg.folderId = folder.folderId
          const result = await processMessage(supabase, account, msg, accessToken, base)
          if (result === 'processed') summary.processed++
          else if (result === 'skipped') summary.skipped++
          else summary.errors++
        }
      }

      // ── Sent folder: import business replies into existing threads ────────
      // This surfaces replies Bimini sends directly from Zoho (outside Caye's
      // dashboard) so the conversation thread shows both sides of the exchange.
      for (const folder of sentFolders) {
        const listUrl = `${base}/api/accounts/${accountId}/messages/view?limit=100&folderId=${folder.folderId}`
        const listRes = await fetch(listUrl, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } })
        if (!listRes.ok) continue
        const listData = await listRes.json()
        const sentMsgsAll: Record<string, unknown>[] = Array.isArray(listData?.data) ? listData.data : []
        // Client-side 30-day filter (Zoho rejects fromDate query param)
        const sentMsgs = sentMsgsAll.filter(m => {
          const t = Number(m.receivedTime ?? m.sentTime ?? 0)
          return !t || t >= fromDateMs
        })
        console.log(`[email/poll] Sent folder: ${sentMsgs.length} messages to check for thread matches`)
        for (const msg of sentMsgs) {
          if (!msg.folderId && !msg.folder_id) msg.folderId = folder.folderId
          const result = await processSentMessage(supabase, account, msg, accessToken, base)
          if (result === 'processed') summary.processed++
          else if (result === 'skipped') summary.skipped++
          else summary.errors++
        }
      }
    } catch (err) {
      console.error(`[email/poll] Account ${String(account.id)} failed:`, err)
      summary.errors++
    }
  }

  console.log('[email/poll] Run complete:', summary)
  return NextResponse.json(summary)
}
