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

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

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
        return raw.includes('<') ? htmlToPlainText(raw) : raw.trim()
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

// ── Web3Forms helpers ───────────────────────────────────────────────────────

interface Web3FormsFields {
  customerName: string
  customerEmail: string
  phone: string | null
  tour: string | null
  date: string | null
  guests: string | null
  notes: string | null
}

/**
 * Returns true if this email is a Web3Forms submission notification
 * rather than a direct email from a customer.
 */
function isWeb3FormsNotification(fromEmail: string, subject: string): boolean {
  const domain = fromEmail.split('@')[1]?.toLowerCase() || ''
  return (
    domain === 'web3forms.com' ||
    domain === 'web3forms.co' ||
    /^tour booking:/i.test(subject.trim())
  )
}

/**
 * Parses the structured "Field: Value" body that Web3Forms sends.
 * Returns null if the required customer email is missing.
 */
function parseWeb3FormsFields(body: string): Web3FormsFields | null {
  const get = (field: string): string | null => {
    const m = body.match(new RegExp(`^${field}:\\s*(.+)$`, 'im'))
    const val = m?.[1]?.trim()
    return val && val.toLowerCase() !== 'none' ? val : null
  }

  const customerEmail = get('Email')
  const customerName = get('Name')
  if (!customerEmail || !customerName) return null

  return {
    customerName,
    customerEmail: customerEmail.toLowerCase(),
    phone: get('Phone'),
    tour: get('Tour'),
    date: get('Date'),
    guests: get('Guests'),
    notes: get('Notes'),
  }
}

/**
 * Builds a structured body to pass to Caye so it has full context
 * about the booking request — tour type, date, group size, etc.
 */
function buildWeb3FormsContext(fields: Web3FormsFields): string {
  const lines = [
    `Customer name: ${fields.customerName}`,
    fields.tour    ? `Tour requested: ${fields.tour}`      : null,
    fields.date    ? `Requested date: ${fields.date}`      : null,
    fields.guests  ? `Number of guests: ${fields.guests}`  : null,
    fields.notes   ? `Customer notes: ${fields.notes}`     : null,
    fields.phone   ? `Phone: ${fields.phone}`              : null,
  ].filter(Boolean)
  return lines.join('\n')
}

type Supabase = ReturnType<typeof createServiceClient>
type Account = Record<string, unknown>

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
  let web3FormsFields: Web3FormsFields | null = null
  if (isWeb3FormsNotification(fromEmail, subject)) {
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
      // Can't extract customer — store raw notification but don't auto-reply
      console.warn(`[email/poll] Web3Forms notification missing customer fields: ${messageId}`)
      return 'skipped'
    }

  }

  // Resolve the effective contact for this message
  const effectiveEmail = web3FormsFields?.customerEmail ?? fromEmail
  const effectiveName  = web3FormsFields?.customerName  ?? fromName

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
    body = await fetchMessageContent(base, String(accountId), messageId, accessToken, String(msg.folderId || msg.folder_id || ''))
  }

  // Fetch workspace AI prompt
  let systemPrompt =
    'You are a helpful assistant for a Caribbean tour business. Reply to customer emails warmly and professionally.'
  const { data: aiConfig } = await supabase
    .from('workspace_ai_config')
    .select('system_prompt')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (aiConfig?.system_prompt) systemPrompt = aiConfig.system_prompt

  // Upsert conversation — for Web3Forms submissions use the customer's email
  // as the channel_conversation_id so follow-up direct emails thread correctly
  const convChannelId = web3FormsFields
    ? `w3f_${web3FormsFields.customerEmail}_${threadId}`
    : threadId

  const { data: conversation, error: convErr } = await supabase
    .from('unified_conversations')
    .upsert(
      {
        connected_account_id: String(account.id),
        channel_type: 'email',
        channel_conversation_id: convChannelId,
        customer_name: effectiveName,
        customer_id: effectiveEmail,
        status: 'open',
        metadata: {
          subject,
          from: web3FormsFields ? effectiveEmail : fromRaw,
          thread_id: threadId,
          ...(web3FormsFields ? { source: 'web3forms', form_fields: web3FormsFields } : {}),
        },
      },
      { onConflict: 'connected_account_id,channel_conversation_id' }
    )
    .select('id')
    .single()

  if (convErr || !conversation) {
    console.error('[email/poll] Conversation upsert failed:', convErr)
    return 'error'
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

  // Don't auto-reply to emails that existed before the account was connected
  if (isHistorical) {
    console.log(`[email/poll] Historical email skipped (no auto-reply): ${messageId}`)
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
      metadata: { generated_by: 'caye', hold_reason: decision.reason },
    })
    console.log(`[email/poll] Held for human: ${effectiveEmail} — ${decision.reason}`)
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

      // Use cached inbox folderId stored at connect time (avoids needing folders scope on every poll)
      const inboxFolderId: string | null = meta.inbox_folder_id || null
      if (!inboxFolderId) {
        console.warn(`[email/poll] No cached inbox_folder_id for account ${accountId} — reconnect Zoho to resolve`)
      }

      // Zoho Mail messages/view only accepts: limit, start, folderId (no sort params)
      if (!inboxFolderId) { summary.errors++; continue }
      const listUrl = `${base}/api/accounts/${accountId}/messages/view?limit=25&folderId=${inboxFolderId}`

      const listRes = await fetch(listUrl, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      })
      const listData = await listRes.json()
      const messages: Record<string, unknown>[] = Array.isArray(listData?.data)
        ? listData.data
        : []

      const zohoStatus = listData?.status?.code ?? listData?.status
      const detail = `account=${accountId} folderId=${inboxFolderId} messages=${messages.length} zohoStatus=${zohoStatus}`
      console.log(`[email/poll] ${detail}`)
      if (!listRes.ok) {
        console.error(`[email/poll] Messages list failed: HTTP ${listRes.status}`, JSON.stringify(listData).slice(0, 400))
      }
      ;(summary.detail as string[]).push(detail)

      for (const msg of messages) {
        const result = await processMessage(supabase, account, msg, accessToken, base)
        if (result === 'processed') summary.processed++
        else if (result === 'skipped') summary.skipped++
        else summary.errors++
      }
    } catch (err) {
      console.error(`[email/poll] Account ${String(account.id)} failed:`, err)
      summary.errors++
    }
  }

  console.log('[email/poll] Run complete:', summary)
  return NextResponse.json(summary)
}
