import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'

const ZOHO_TOKEN_URL = 'https://accounts.zoho.com/oauth/v2/token'
const WORKSPACE = '653257d9-c0f1-4271-be6d-3e2596fd893e'

async function refresh(rt: string) {
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
  return (await r.json()).access_token as string
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: acc } = await sb.from('connected_accounts').select('*').eq('user_id', WORKSPACE).eq('channel_type', 'email').single()
  const meta = (acc.metadata || {}) as Record<string, string>
  const apiDomain = meta.zoho_api_domain || 'https://www.zohoapis.com'
  const zid = meta.zoho_account_id || acc.channel_account_id
  let tok = acc.access_token
  if (new Date(acc.token_expires_at).getTime() < Date.now() + 60_000) tok = await refresh(acc.refresh_token)
  const base = apiDomain.replace('www.zohoapis', 'mail.zoho')
  const foldersRes = await fetch(`${base}/api/accounts/${zid}/folders`, { headers: { Authorization: `Zoho-oauthtoken ${tok}` } })
  const folders = await foldersRes.json()
  const sent = (folders.data || []).find((f: any) => /sent/i.test(f.folderName || f.name || ''))
  console.log('sent folder', sent?.folderId || sent?.id, sent?.folderName || sent?.name)
  const fid = sent?.folderId || sent?.id
  const url = `${base}/api/accounts/${zid}/messages/view?folderId=${fid}&limit=10`
  const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${tok}` } })
  console.log('status', r.status)
  const data = await r.json()
  for (const m of (data.data || [])) {
    console.log(`${m.receivedTime}  to=${m.toAddress}  subj=${m.subject}  msgId=${m.messageId}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
