/**
 * One-off: backfill Michelle Helmer's original inquiry from Karenda's
 * Zoho mailbox into the existing unified_conversations thread.
 *
 * Background: Caye's first stored message on Michelle's conversation is
 * Karenda's outbound at 2026-06-24 00:10:54 UTC — the response to
 * Michelle's original inquiry. Michelle's original itself is in
 * Karenda's Zoho inbox but never landed in Caye because it pre-dated
 * Caye's tracking on that thread (different Zoho threadId).
 *
 * This script: refreshes the workspace's Zoho token, searches the
 * mailbox for messages from helmer.michelle@gmx.de before Karenda's
 * outbound, fetches the content, and inserts a backfilled customer row.
 *
 * Run from Products/Caye: `npx tsx scripts/backfill-michelle-original.ts`
 */
// Run with `node --env-file=.env.local --import tsx scripts/backfill-michelle-original.ts`
// (or `npx tsx --env-file=.env.local scripts/...`) to get .env.local loaded.
import { createClient } from '@supabase/supabase-js'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const WORKSPACE = '653257d9-c0f1-4271-be6d-3e2596fd893e'
const CONVERSATION_ID = '6ca51ea9-46f7-43a2-8dbb-aa01a924cc43'
const CUSTOMER_EMAIL = 'helmer.michelle@gmx.de'
const CUTOFF_ISO = '2026-06-24T00:10:54Z'

async function refresh(rt: string): Promise<string> {
  const r = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      refresh_token: rt,
    }),
  })
  const data = await r.json()
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data).slice(0, 300)}`)
  }
  return data.access_token as string
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: acc, error: accErr } = await sb
    .from('connected_accounts')
    .select('*')
    .eq('user_id', WORKSPACE)
    .eq('channel_type', 'email')
    .single()
  if (accErr || !acc) throw new Error(`No connected account: ${accErr?.message}`)

  const meta = (acc.metadata || {}) as Record<string, string>
  const apiDomain = meta.zoho_api_domain || 'https://www.zohoapis.com'
  const zid = meta.zoho_account_id || acc.channel_account_id
  const base = apiDomain.replace('www.zohoapis', 'mail.zoho')

  let tok = acc.access_token as string
  if (new Date(acc.token_expires_at).getTime() < Date.now() + 60_000) {
    tok = await refresh(acc.refresh_token)
    console.log('Refreshed Zoho token')
  }

  // Zoho's searchKey API doesn't filter as expected — it returns
  // unrelated messages when given `from:email`. Fall back to listing
  // the Inbox folder and filtering client-side by fromAddress, same
  // as the email-poll route does.
  const foldersRes = await fetch(`${base}/api/accounts/${zid}/folders`, {
    headers: { Authorization: `Zoho-oauthtoken ${tok}` },
  })
  const folders = await foldersRes.json()
  const folderList: Array<Record<string, unknown>> = Array.isArray(folders?.data)
    ? folders.data
    : []
  const inbox = folderList.find(
    (f) =>
      String(f.folderName || f.name || '').toLowerCase() === 'inbox' ||
      String(f.folderType || '').toLowerCase().includes('inbox')
  )
  if (!inbox) throw new Error('No Inbox folder found in Zoho')
  const inboxId = inbox.folderId || inbox.id
  console.log(`Inbox folder: ${inbox.folderName || inbox.name} (${inboxId})`)

  // Paginate back through inbox listing aggressively — Michelle's original
  // could be days or weeks earlier than Karenda's outbound. 20 pages =
  // 2000 messages, which is ~2-6 months of normal Bimini volume.
  const allHits: Array<Record<string, unknown>> = []
  let start = 1
  const pageSize = 100
  let oldestSeen = Infinity
  for (let page = 0; page < 20; page++) {
    const listUrl = `${base}/api/accounts/${zid}/messages/view?folderId=${inboxId}&start=${start}&limit=${pageSize}`
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Zoho-oauthtoken ${tok}` },
    })
    const listData = await listRes.json()
    const msgs: Array<Record<string, unknown>> = Array.isArray(listData?.data)
      ? listData.data
      : []
    if (msgs.length === 0) break
    for (const m of msgs) {
      const fromAddr = String(m.fromAddress || m.sender || '').toLowerCase()
      if (fromAddr.includes(CUSTOMER_EMAIL.toLowerCase())) {
        allHits.push(m)
      }
    }
    const oldest = Number(msgs[msgs.length - 1].receivedTime || 0)
    if (oldest) oldestSeen = Math.min(oldestSeen, oldest)
    if (msgs.length < pageSize) break // last page
    start += pageSize
  }
  console.log(
    `Paged through ${start - 1 + pageSize} inbox messages back to ` +
      `${oldestSeen === Infinity ? 'unknown' : new Date(oldestSeen).toISOString()}. ` +
      `Found ${allHits.length} from ${CUSTOMER_EMAIL}.`
  )
  for (const h of allHits) {
    const t = h.receivedTime ? new Date(Number(h.receivedTime)).toISOString() : '?'
    console.log(
      `  - ${t}  msgId=${h.messageId}  subject=${String(h.subject || '').slice(0, 60)}  threadId=${h.threadId}`
    )
  }
  const hits = allHits

  // Find the earliest message before our cutoff (Karenda's first stored outbound).
  const cutoffMs = new Date(CUTOFF_ISO).getTime()
  const candidates = hits
    .map((m) => ({
      ...m,
      receivedTimeMs: Number(m.receivedTime || 0),
    }))
    .filter((m) => m.receivedTimeMs > 0 && m.receivedTimeMs < cutoffMs)
    .sort((a, b) => a.receivedTimeMs - b.receivedTimeMs)

  if (candidates.length === 0) {
    console.log(`\nNo prior Michelle messages found before ${CUTOFF_ISO}.`)
    console.log(
      'Either her original wasn\'t via email (phone / WhatsApp / etc.) ' +
      'or it\'s outside Zoho\'s search index.'
    )
    return
  }

  const original = candidates[0]
  console.log(
    `\nOriginal: ${new Date(original.receivedTimeMs).toISOString()}  ` +
      `msgId=${original.messageId}  ` +
      `subject="${original.subject}"`
  )

  // Fetch content — Zoho requires folderId in the URL for some accounts;
  // try the folder-scoped URL first, then the global one.
  const folderId = original.folderId || original.folder_id || inboxId
  const urls = [
    folderId
      ? `${base}/api/accounts/${zid}/folders/${folderId}/messages/${original.messageId}/content`
      : null,
    `${base}/api/accounts/${zid}/messages/${original.messageId}/content`,
  ].filter(Boolean) as string[]
  let cData: Record<string, unknown> | null = null
  for (const url of urls) {
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${tok}` } })
    if (r.ok) {
      cData = await r.json()
      const ok = (cData as { data?: { content?: unknown } })?.data?.content
      if (typeof ok === 'string' && ok.length > 0) break
    } else {
      console.log(`Content fetch ${r.status} at ${url}`)
    }
  }
  const rawContent =
    typeof cData?.data?.content === 'string' ? (cData.data.content as string) : ''
  if (!rawContent) {
    console.log('No content returned. Payload:', JSON.stringify(cData).slice(0, 400))
    return
  }

  // Strip HTML + quoted thread using the same helper the live webhook uses
  const { htmlToPlainText } = await import('../lib/email-text')
  const cleaned = htmlToPlainText(rawContent)
  console.log('\nCleaned content preview:')
  console.log('---')
  console.log(cleaned.slice(0, 500))
  console.log('---')

  // Dedup: skip if a message with this Zoho id already exists
  const { data: existing } = await sb
    .from('unified_messages')
    .select('id')
    .eq('channel_message_id', String(original.messageId))
    .maybeSingle()
  if (existing) {
    console.log(`\nMessage already exists in unified_messages (id=${existing.id}). Skipping insert.`)
    return
  }

  // Insert as a customer message on the existing conversation
  const sentAt = new Date(original.receivedTimeMs).toISOString()
  const { data: inserted, error: insErr } = await sb
    .from('unified_messages')
    .insert({
      conversation_id: CONVERSATION_ID,
      channel_message_id: String(original.messageId),
      sender_type: 'customer',
      content: cleaned,
      message_type: 'text',
      sent_at: sentAt,
      status: 'delivered',
      metadata: {
        subject: original.subject,
        zoho_message_id: original.messageId,
        zoho_thread_id: original.threadId,
        from: CUSTOMER_EMAIL,
        backfilled_at: new Date().toISOString(),
        backfill_source: 'scripts/backfill-michelle-original.ts',
        backfill_reason: 'Original inquiry pre-dated Caye tracking on this thread (different Zoho threadId)',
      },
    })
    .select('id')
    .single()

  if (insErr) {
    console.error('Insert failed:', insErr)
    return
  }
  console.log(`\nInserted as ${inserted.id}, sent_at=${sentAt}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
