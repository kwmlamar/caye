import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { correlateRecruiterEmail } from '@/lib/job-search/email-correlation'
import { getFreshFounderZohoAccount, zohoMailBase, type FounderZohoAccount } from '@/lib/job-search/founder-zoho'
import { htmlToPlainText } from '@/lib/email-text'

async function messageBody(base: string, accountId: string, folderId: string, messageId: string, token: string) {
  const res = await fetch(`${base}/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) return ''
  const json = await res.json() as { data?: Record<string, unknown> }
  const data = json.data ?? {}
  return htmlToPlainText(String(data.content || data.htmlContent || data.textContent || data.summary || ''))
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret && provided !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const { data, error } = await supabase.from('founder_connected_accounts').select('*')
    .eq('provider', 'zoho').eq('is_active', true).eq('needs_reauth', false)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const stats = { accounts: data?.length ?? 0, inspected: 0, correlated: 0, duplicates: 0, unmatched: 0, errors: 0 }
  for (const raw of (data ?? []) as FounderZohoAccount[]) {
    try {
      const account = await getFreshFounderZohoAccount(raw)
      const base = zohoMailBase(account.metadata.zoho_api_domain)
      let folderId = account.metadata.inbox_folder_id
      if (!folderId) {
        const foldersRes = await fetch(`${base}/api/accounts/${account.account_id}/folders`, {
          headers: { Authorization: `Zoho-oauthtoken ${account.access_token}` },
        })
        const foldersJson = await foldersRes.json() as { data?: Array<{ folderId: string; folderType?: string; folderName?: string }> }
        folderId = foldersJson.data?.find((f) => f.folderType === 'Inbox' || /^inbox$/i.test(f.folderName ?? ''))?.folderId ?? ''
      }
      if (!folderId) throw new Error('Zoho inbox folder not found')

      const listRes = await fetch(`${base}/api/accounts/${account.account_id}/messages/view?limit=100&folderId=${folderId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${account.access_token}` },
      })
      const listJson = await listRes.json() as { data?: Record<string, unknown>[] }
      if (!listRes.ok) throw new Error(`Zoho message list failed: HTTP ${listRes.status}`)
      const cutoff = account.last_polled_at ? new Date(account.last_polled_at).getTime() - 5 * 60_000 : Date.now() - 7 * 86400_000
      for (const msg of listJson.data ?? []) {
        const receivedMs = Number(msg.receivedTime ?? msg.sentTime ?? 0)
        if (receivedMs && receivedMs < cutoff) continue
        const messageId = String(msg.messageId || msg.message_id || '')
        if (!messageId) continue
        stats.inspected++
        const subject = String(msg.subject || '(no subject)')
        const from = String(msg.fromAddress || msg.from_address || '')
        const body = await messageBody(base, account.account_id, folderId, messageId, account.access_token)
        const result = await correlateRecruiterEmail({
          provider: 'zoho', messageId, emailSubject: subject, emailFrom: from,
          emailSnippet: body.slice(0, 4000),
          receivedAt: receivedMs ? new Date(receivedMs).toISOString() : null,
        })
        if (result.status === 'correlated') stats.correlated++
        else if (result.status === 'duplicate') stats.duplicates++
        else stats.unmatched++
      }
      await supabase.from('founder_connected_accounts').update({ last_polled_at: new Date().toISOString() }).eq('id', account.id)
    } catch (err) {
      console.error('[job-search-email-poll] account failed', raw.id, err)
      stats.errors++
    }
  }
  return NextResponse.json(stats)
}
