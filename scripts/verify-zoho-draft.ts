/**
 * verify-zoho-draft.ts
 *
 * One-time safety check that unblocks draft_in_inbox.
 *
 * THE QUESTION THIS ANSWERS
 * createZohoReplyDraft asks Zoho to save instead of send by passing
 * `mode: "draft"` to the same /messages endpoint that sends. Nobody has ever
 * confirmed Zoho honours it. If it doesn't, the call succeeds quietly and
 * delivers a half-written reply to a real guest in the owner's name.
 *
 * WHY THIS IS SAFE TO RUN
 * The draft is addressed to an address YOU control, passed on the command
 * line — never a customer. If Zoho ignores the flag and sends, the mail
 * lands in your own inbox and the blast radius is one email to yourself.
 *
 * USAGE
 *   npx tsx scripts/verify-zoho-draft.ts you@yourdomain.com
 *
 * Then check both places and re-run with the verdict:
 *   npx tsx scripts/verify-zoho-draft.ts you@yourdomain.com --confirm-drafted
 *   npx tsx scripts/verify-zoho-draft.ts you@yourdomain.com --confirm-sent
 *
 * --confirm-drafted flips platform_settings.zoho_draft_mode_verified to
 * 'true' and draft_in_inbox starts working. --confirm-sent leaves the gate
 * shut and records the failure, which means Zoho's draft mode is unusable
 * and the tool must stay off.
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const WORKSPACE = '653257d9-c0f1-4271-be6d-3e2596fd893e' // Bimini Island Tours
const VERIFIED_KEY = 'zoho_draft_mode_verified'

const MARKER = `caye-draft-verification-${Date.now()}`

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )
}

async function refresh(refreshToken: string): Promise<string> {
  const r = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID!,
      client_secret: process.env.ZOHO_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }),
  })
  const data = await r.json()
  if (!data.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`)
  return data.access_token as string
}

async function recordVerdict(verified: boolean, note: string) {
  const supabase = sb()
  const { error } = await supabase.from('platform_settings').upsert(
    { key: VERIFIED_KEY, value: verified ? 'true' : 'false', updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  )
  if (error) throw new Error(`Failed to record verdict: ${error.message}`)
  console.log(`\n${verified ? '✅' : '🚫'} ${VERIFIED_KEY} = ${verified}\n   ${note}`)
}

async function main() {
  const to = process.argv[2]
  const confirmDrafted = process.argv.includes('--confirm-drafted')
  const confirmSent = process.argv.includes('--confirm-sent')

  if (!to || to.startsWith('--')) {
    console.error('Usage: npx tsx scripts/verify-zoho-draft.ts <your-own-email> [--confirm-drafted|--confirm-sent]')
    process.exit(1)
  }

  if (confirmDrafted && confirmSent) {
    console.error('Pick one verdict, not both.')
    process.exit(1)
  }

  if (confirmDrafted) {
    await recordVerdict(true, 'draft_in_inbox is now live.')
    return
  }
  if (confirmSent) {
    await recordVerdict(
      false,
      'Zoho ignores mode:draft on this account. draft_in_inbox stays disabled — do not wire it up.'
    )
    return
  }

  const supabase = sb()
  const { data: account, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('user_id', WORKSPACE)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (error || !account) throw new Error('No active Zoho account for the Bimini workspace')

  const meta = (account.metadata || {}) as Record<string, string>
  const apiDomain = meta.zoho_api_domain || 'https://www.zohoapis.com'
  const zohoAccountId = meta.zoho_account_id || account.channel_account_id
  const accessToken = await refresh(account.refresh_token!)

  // Deliberately a standalone draft, not a reply into a customer thread —
  // there is no reason to involve a real guest's thread in a test whose whole
  // premise is that the API might send.
  const url = `${apiDomain.replace(/\/$/, '')}/mail/v1/api/accounts/${zohoAccountId}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fromAddress: account.channel_account_name || '',
      toAddress: to,
      subject: `[Caye verification] ${MARKER}`,
      content:
        'This is an automated one-time check of Zoho save-as-draft behaviour.\n\n' +
        'If you are reading this in your INBOX, Zoho ignored mode:draft and SENT it — ' +
        'run again with --confirm-sent.\n\n' +
        'If you are reading this in DRAFTS, the flag works — run again with --confirm-drafted.',
      mailFormat: 'plaintext',
      mode: 'draft',
    }),
  })

  const data = await res.json()
  console.log(`HTTP ${res.status} — ${JSON.stringify(data).slice(0, 400)}`)

  if (!res.ok) {
    console.error('\n🚫 Request failed outright. Gate stays shut; nothing was created.')
    process.exit(1)
  }

  console.log(`
──────────────────────────────────────────────────────────────
Now go and look. Search both folders for:  ${MARKER}

  In DRAFTS only  →  npx tsx scripts/verify-zoho-draft.ts ${to} --confirm-drafted
  In your INBOX   →  npx tsx scripts/verify-zoho-draft.ts ${to} --confirm-sent

Until you run one of those, draft_in_inbox stays disabled.
──────────────────────────────────────────────────────────────`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
