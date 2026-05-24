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
    // Treat block-level closings as line breaks so HTML tables/lists
    // (used by Web3Forms etc.) don't collapse into one long line
    .replace(/<\/(tr|td|th|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    // Normalize line endings, strip leading whitespace per line, collapse blanks
    .replace(/\r\n?/g, '\n')
    .split('\n').map(l => l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')).join('\n')
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

interface Web3FormsParsed {
  customerName: string
  customerEmail: string
  /** All fields from the submission, in source order, using the form's own labels. */
  fields: Array<{ label: string; value: string }>
}

// Caye is a general receptionist — these are the only two fields the rest of
// the system semantically needs (to identify the customer). Everything else
// is rendered with whatever label the form actually uses.
const NAME_ALIASES = ['name', 'your name', 'full name', 'customer name', 'first name']
const EMAIL_ALIASES = ['email', 'email address', 'your email', 'customer email']

// Boilerplate text Web3Forms wraps around the field list — used to find the
// fields section in the email body.
const FIELDS_START_RE = /details below\.?\s*$/im
const FIELDS_END_RE = /(visitor ip\b|report spam|powered by web3forms|don'?t want these emails)/i

/**
 * Returns true if this email is a Web3Forms submission notification
 * rather than a direct email from a customer.
 */
function isWeb3FormsNotification(fromEmail: string, subject: string): boolean {
  const domain = fromEmail.split('@')[1]?.toLowerCase() || ''
  return domain === 'web3forms.com' || domain === 'web3forms.co'
}

/**
 * Parses a Web3Forms submission email into a generic ordered list of
 * label/value pairs. Doesn't assume any vertical (tour/SaaS/etc.) —
 * uses whatever labels the form's own fields have.
 */
function parseWeb3FormsFields(body: string): Web3FormsParsed | null {
  // Narrow to the fields section (between the "Details below." marker and the footer)
  const startMatch = body.match(FIELDS_START_RE)
  const startIdx = startMatch ? startMatch.index! + startMatch[0].length : 0
  const tail = body.slice(startIdx)
  const endMatch = tail.match(FIELDS_END_RE)
  const fieldsBlock = (endMatch ? tail.slice(0, endMatch.index) : tail).trim()
  if (!fieldsBlock) return null

  // Web3Forms layouts:
  //   A: label and value alternate as blocks separated by blank lines
  //      ("Name\n\nLamar Sineus\n\nBusiness name\n\ntropitech")
  //   B: each block has "label\nvalue" on consecutive non-blank lines
  //   C: legacy "Label: value" on one line
  const fields: Array<{ label: string; value: string }> = []
  const blocks = fieldsBlock.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean)

  // Try Layout A: alternating label/value blocks
  if (blocks.length >= 2 && blocks.length % 2 === 0) {
    let ok = true
    const tentative: typeof fields = []
    for (let i = 0; i < blocks.length; i += 2) {
      const label = blocks[i].split('\n')[0].trim()
      const value = blocks[i + 1].split('\n').map(l => l.trim()).filter(Boolean).join(' ')
      if (!label || !value || label.length > 60) { ok = false; break }
      if (value.toLowerCase() === 'none') continue
      tentative.push({ label, value })
    }
    if (ok) fields.push(...tentative)
  }

  // Fallback Layout B: "label\nvalue" inside a single block, or Layout C inline
  if (fields.length === 0) {
    for (const block of blocks) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length === 0) continue
      // Inline "Label: value"
      const inline = lines[0].match(/^([^:]{1,60}):\s*(.+)$/)
      if (inline) {
        const value = [inline[2], ...lines.slice(1)].join(' ').trim()
        if (value && value.toLowerCase() !== 'none') {
          fields.push({ label: inline[1].trim(), value })
        }
        continue
      }
      // Stacked "label\nvalue"
      if (lines.length >= 2) {
        const label = lines[0]
        const value = lines.slice(1).join(' ')
        if (label.length <= 60 && value && value.toLowerCase() !== 'none') {
          fields.push({ label, value })
        }
      }
    }
  }

  if (fields.length === 0) return null

  // Extract identity fields by alias (only Name + Email are semantically needed)
  const findByAlias = (aliases: string[]): string | null => {
    for (const f of fields) {
      if (aliases.includes(f.label.toLowerCase())) return f.value
    }
    return null
  }
  const customerName = findByAlias(NAME_ALIASES)
  const customerEmail = findByAlias(EMAIL_ALIASES)
  if (!customerName || !customerEmail) return null

  return {
    customerName,
    customerEmail: customerEmail.toLowerCase(),
    fields,
  }
}

/**
 * Renders the parsed submission as plain "Label: value" lines using the
 * form's own field labels — no vertical-specific renaming.
 */
function buildWeb3FormsContext(parsed: Web3FormsParsed): string {
  const lines = parsed.fields.map(f => `${f.label}: ${f.value}`)
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
  let web3FormsFields: Web3FormsParsed | null = null
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
      // Couldn't extract structured customer fields — fall through and save the raw
      // email as a regular inbound message. Better to surface it than drop it.
      console.warn(`[email/poll] Web3Forms parse failed, saving as raw email: ${messageId}`)
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
    .select('system_prompt, ai_enabled')
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

  if (aiConfig?.ai_enabled === false) {
    console.log(`[email/poll] AI disabled for workspace ${workspaceId} — skipping auto-reply`)
    return 'skipped'
  }

  // Never auto-reply to vendor/system addresses (noreply@, mailer-daemon@, etc.).
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

      // Fetch all folders so we can poll Inbox + custom folders (Zoho filters
      // often route Web3Forms/form submissions to a sub-folder). Skip system
      // folders that wouldn't contain inbound customer messages.
      const foldersRes = await fetch(
        `${base}/api/accounts/${accountId}/folders`,
        { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } }
      )
      const foldersData = await foldersRes.json() as { data?: { folderId: string; folderName: string; folderType?: string }[] }
      const allFolders = foldersData?.data ?? []
      const SKIP_TYPES = new Set(['Sent', 'Drafts', 'Trash', 'Outbox', 'Templates'])
      const pollFolders = allFolders.filter(f => !SKIP_TYPES.has(f.folderType ?? ''))

      if (!pollFolders.length) {
        console.warn(`[email/poll] No pollable folders for account ${accountId}`)
        summary.errors++
        continue
      }

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
        const detail = `account=${accountId} folder=${folder.folderName}(${folder.folderId}) type=${folder.folderType} messages=${messages.length} zohoStatus=${zohoStatus}`
        console.log(`[email/poll] ${detail}`)
        if (!listRes.ok) {
          console.error(`[email/poll] Messages list failed for folder ${folder.folderName}: HTTP ${listRes.status}`, JSON.stringify(listData).slice(0, 400))
          continue
        }
        ;(summary.detail as string[]).push(detail)

        for (const msg of messages) {
          // Ensure folderId is on the message so processMessage can use it for content fetch
          if (!msg.folderId && !msg.folder_id) msg.folderId = folder.folderId
          const result = await processMessage(supabase, account, msg, accessToken, base)
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
