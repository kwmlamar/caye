'use client'

import { useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'

type Account = { email_address: string; needs_reauth: boolean; last_polled_at: string | null }

export default function JobSearchMailCard() {
  const [account, setAccount] = useState<Account | null>(null)
  const [connectUrl, setConnectUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      const { session } = await getSession()
      if (!session) return setLoading(false)
      const res = await fetch('/api/founder/job-search-email', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const body = await res.json()
        setAccount(body.account)
        setConnectUrl(body.connectUrl)
      }
      setLoading(false)
    })()
  }, [])

  return (
    <section style={{ maxWidth: 520, marginTop: 28, paddingTop: 22, borderTop: '1px solid #28282d' }}>
      <div style={{ fontSize: 13, fontWeight: 650, color: '#f4f4f5' }}>Founder job-search mailbox</div>
      <p style={{ margin: '6px 0 14px', fontSize: 12.5, lineHeight: 1.5, color: '#71717a' }}>
        Private recruiter mail. Isolated from every customer workspace and front-desk worker.
      </p>
      {loading ? <span style={{ color: '#71717a', fontSize: 12 }}>Checking…</span> : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: account ? '#d4d4d8' : '#71717a' }}>
              {account?.email_address ?? 'Not connected'}
            </div>
            {account?.last_polled_at && <div style={{ fontSize: 10.5, color: '#52525b', marginTop: 2 }}>Last checked {new Date(account.last_polled_at).toLocaleString()}</div>}
          </div>
          {connectUrl && (
            <button type="button" onClick={() => { window.location.href = connectUrl }} style={{
              border: '1px solid #3f3f46', borderRadius: 8, background: 'transparent', color: '#4EBECE',
              padding: '7px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
              {account ? (account.needs_reauth ? 'Reconnect' : 'Change') : 'Connect Zoho'}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
