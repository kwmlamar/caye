'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import SIcon from './SIcon'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

interface ConnectedAccount {
  id: string
  channel_type: string
  channel_account_name: string | null
  channel_username: string | null
  channel_account_id: string | null
  is_active: boolean
  needs_reauth: boolean | null
  created_at: string
}

const CHANNEL_META: Record<string, { name: string; label: string; bg: string; note: string }> = {
  whatsapp: {
    name: 'WhatsApp Business',
    label: 'W',
    bg: '#22c55e',
    note: 'Connect your WhatsApp Business account so guests can message you directly.',
  },
  instagram: {
    name: 'Instagram DMs',
    label: 'IG',
    bg: 'linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)',
    note: 'Connect your Instagram account to route DMs into the TropiChat inbox.',
  },
  messenger: {
    name: 'Messenger',
    label: 'M',
    bg: '#3b82f6',
    note: 'Connect your Facebook Page to handle Messenger conversations.',
  },
  email: {
    name: 'Zoho Mail',
    label: '@',
    bg: 'var(--tc-ink)',
    note: 'Connect your Zoho Mail account so Caye can read and reply to guest emails.',
  },
  sms: {
    name: 'SMS',
    label: '#',
    bg: '#6b7681',
    note: 'Cruise-line guests often arrive without WhatsApp data. SMS catches them at the dock.',
  },
}

const CHANNEL_ORDER = ['whatsapp', 'instagram', 'messenger', 'email', 'sms']

// When a channel type has multiple rows, prefer the active one; break ties by newest created_at
function pickBest(rows: ConnectedAccount[]): ConnectedAccount {
  const active = rows.filter(r => r.is_active)
  const pool = active.length > 0 ? active : rows
  return pool.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
}

export default function ChannelsPanel() {
  const params = useParams()
  const urlWorkspaceId = params?.workspaceId as string | undefined
  const { workspaceId: ctxWorkspaceId } = useWorkspace()
  // Prefer the URL param — it's always authoritative for which workspace we're viewing
  const workspaceId = urlWorkspaceId || ctxWorkspaceId
  const [byType, setByType] = useState<Record<string, ConnectedAccount>>({})
  const [loading, setLoading] = useState(true)
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false)
  const [messengerPages, setMessengerPages] = useState<{ id: string; name: string; token: string }[] | null>(null)
  const searchParams = useSearchParams()
  const router = useRouter()

  useEffect(() => {
    const zohoConnected = searchParams.get('zoho_connected')
    const zohoError = searchParams.get('zoho_error')
    const msgrConnected = searchParams.get('messenger_connected')
    const msgrError = searchParams.get('messenger_error')
    const msgrPages = searchParams.get('messenger_pages')

    if (zohoConnected === '1') toast.success('Zoho Mail connected')
    else if (zohoError === 'access_denied') toast.error('Zoho authorization was denied')
    else if (zohoError) toast.error(`Zoho connection failed (${zohoError})`)

    if (msgrConnected === '1') { toast.success('Messenger connected'); fetchAccounts() }
    else if (msgrError === 'access_denied') toast.error('Facebook authorization was denied')
    else if (msgrError === 'no_pages') toast.error('No Facebook Pages found — make sure you manage at least one Page')
    else if (msgrError) toast.error(`Messenger connection failed (${msgrError})`)

    if (msgrPages) {
      try {
        const decoded = JSON.parse(Buffer.from(msgrPages, 'base64url').toString())
        setMessengerPages(decoded)
      } catch { /* ignore */ }
    }

    // Strip the one-time params so they don't re-fire on refresh
    const clean = new URLSearchParams(searchParams.toString())
    clean.delete('zoho_connected'); clean.delete('zoho_error')
    clean.delete('messenger_connected'); clean.delete('messenger_error'); clean.delete('messenger_pages')
    router.replace(`?${clean.toString()}`)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchAccounts = useCallback(async () => {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('connected_accounts')
      .select('id, channel_type, channel_account_name, channel_username, channel_account_id, is_active, needs_reauth, created_at')
      .eq('user_id', workspaceId)

    if (error) { toast.error('Failed to load channels'); setLoading(false); return }

    const grouped: Record<string, ConnectedAccount[]> = {}
    for (const row of (data ?? [])) {
      if (!grouped[row.channel_type]) grouped[row.channel_type] = []
      grouped[row.channel_type].push(row as ConnectedAccount)
    }
    const best: Record<string, ConnectedAccount> = {}
    for (const [type, rows] of Object.entries(grouped)) {
      best[type] = pickBest(rows)
    }
    setByType(best)
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { fetchAccounts() }, [fetchAccounts])

  const handleDisconnect = async (account: ConnectedAccount) => {
    const supabase = getSupabase()
    const { error } = await supabase
      .from('connected_accounts')
      .update({ is_active: false })
      .eq('id', account.id)
    if (error) { toast.error('Failed to disconnect'); return }
    toast.success(`${CHANNEL_META[account.channel_type]?.name ?? account.channel_type} disconnected`)
    fetchAccounts()
  }

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Channels</div>
          <h1>Where guests reach you</h1>
          <p className="set-page-desc">
            Every connected channel funnels into the same TropiChat inbox. Caye AI replies on all connected channels by default.
          </p>
        </div>
        <div className="ph-right">
          <button className="btn-ghost">Test inbound message</button>
        </div>
      </header>

      <div className="channels-grid">
        {CHANNEL_ORDER.map((type) => {
          const meta = CHANNEL_META[type]
          const account = byType[type] ?? null
          const isConnected = account?.is_active === true
          const needsReauth = account?.needs_reauth === true
          const handle = account
            ? (account.channel_username || account.channel_account_name || account.channel_account_id || '—')
            : 'Not connected'
          const since = account
            ? `Connected ${new Date(account.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
            : '—'

          return (
            <div key={type} className={'channel-card' + (isConnected ? ' connected' : '')}>
              <div className="channel-head">
                <span className="channel-mark" style={{ background: meta.bg }}>{meta.label}</span>
                <div className="channel-info">
                  <div className="channel-name">{meta.name}</div>
                  <div className="channel-meta">
                    {loading ? '—' : handle}
                  </div>
                </div>
                <span className={'channel-status ' + (isConnected ? 'on' : 'off')}>
                  <span
                    className="pip"
                    style={needsReauth ? { background: '#F59E0B' } : {}}
                  />
                  {isConnected ? 'Connected' : needsReauth ? 'Reconnect' : 'Off'}
                </span>
              </div>

              <div className="channel-body">
                {isConnected ? (
                  <div style={{ fontSize: 12.5, color: 'var(--tc-ink-mute)', lineHeight: 1.5 }}>
                    Active — Caye replies on this channel automatically.
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--tc-ink-mute)', lineHeight: 1.5 }}>
                    {meta.note}
                  </div>
                )}
              </div>

              <div className="channel-foot">
                <span style={{ fontSize: 11.5, color: 'var(--tc-ink-faint)', fontFamily: 'var(--font-mono)', letterSpacing: '.04em' }}>
                  {loading ? '—' : since}
                </span>
                {isConnected && !needsReauth ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-ghost sm">Configure</button>
                    <button
                      className="btn-ghost sm danger"
                      onClick={() => account && handleDisconnect(account)}
                    >
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-solid sm"
                    onClick={() => {
                      if (type === 'email') {
                        window.location.href = `/api/auth/zoho?workspaceId=${workspaceId}`
                      } else if (type === 'whatsapp') {
                        setShowWhatsAppModal(true)
                      } else if (type === 'messenger') {
                        window.location.href = `/api/auth/meta?workspaceId=${workspaceId}`
                      }
                    }}
                    disabled={type !== 'email' && type !== 'whatsapp' && type !== 'messenger'}
                    title={type !== 'email' && type !== 'whatsapp' && type !== 'messenger' ? 'Coming soon' : undefined}
                  >
                    <SIcon name="plus" size={12} />
                    {needsReauth ? 'Reconnect' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {showWhatsAppModal && workspaceId && (
        <WhatsAppModal
          workspaceId={workspaceId}
          onSuccess={fetchAccounts}
          onClose={() => setShowWhatsAppModal(false)}
        />
      )}

      {messengerPages && workspaceId && (
        <MessengerPagePicker
          pages={messengerPages}
          workspaceId={workspaceId}
          onSuccess={() => { setMessengerPages(null); fetchAccounts() }}
          onClose={() => setMessengerPages(null)}
        />
      )}
    </div>
  )
}

function WhatsAppModal({ workspaceId, onSuccess, onClose }: {
  workspaceId: string
  onSuccess: () => void
  onClose: () => void
}) {
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const res = await fetch('/api/channels/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, phoneNumberId, accessToken, displayName: displayName || undefined }),
      })
      const data = await res.json() as { success?: boolean; error?: string }
      if (!res.ok || !data.success) {
        toast.error(data.error ?? 'Connection failed')
        return
      }
      toast.success('WhatsApp connected')
      onSuccess()
      onClose()
    } catch {
      toast.error('Connection failed')
    } finally {
      setSubmitting(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  }
  const hintStyle: React.CSSProperties = {
    fontSize: 11,
    color: 'var(--tc-ink-faint)',
    marginTop: 4,
  }
  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 12.5,
    fontWeight: 500,
    color: 'var(--tc-ink)',
    marginBottom: 5,
  }
  const fieldStyle: React.CSSProperties = { marginBottom: 16 }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', borderRadius: 12, padding: 24,
          width: '100%', maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 600, color: 'var(--tc-ink)' }}>
          Connect WhatsApp Business
        </h2>

        <div style={fieldStyle}>
          <label style={labelStyle}>Phone Number ID</label>
          <input
            style={inputStyle}
            value={phoneNumberId}
            onChange={e => setPhoneNumberId(e.target.value)}
            placeholder="123456789012345"
          />
          <p style={hintStyle}>Meta Business Suite → WhatsApp → API Setup</p>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Permanent Access Token</label>
          <input
            style={inputStyle}
            type="password"
            value={accessToken}
            onChange={e => setAccessToken(e.target.value)}
            placeholder="EAAxxxxx..."
          />
          <p style={hintStyle}>Meta App Dashboard → Access Tokens</p>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Display name (optional)</label>
          <input
            style={inputStyle}
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="e.g. ODS Construction"
          />
          <p style={hintStyle}>Shown in your inbox — leave blank to use the verified name from Meta</p>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button className="btn-ghost sm" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-solid sm"
            onClick={handleSubmit}
            disabled={submitting || !phoneNumberId || !accessToken}
          >
            {submitting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Shown only when the user manages multiple Facebook Pages after OAuth.
// They pick which one to connect to this workspace.
function MessengerPagePicker({ pages, workspaceId, onSuccess, onClose }: {
  pages: { id: string; name: string; token: string }[]
  workspaceId: string
  onSuccess: () => void
  onClose: () => void
}) {
  const [saving, setSaving] = useState<string | null>(null)

  const handlePick = async (page: { id: string; name: string; token: string }) => {
    setSaving(page.id)
    try {
      const res = await fetch('/api/channels/messenger/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, pageId: page.id, accessToken: page.token, pageName: page.name }),
      })
      const data = await res.json() as { success?: boolean; error?: string }
      if (!res.ok || !data.success) { toast.error(data.error ?? 'Connection failed'); return }
      toast.success(`Messenger connected — ${page.name}`)
      onSuccess()
    } catch {
      toast.error('Connection failed')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: '#fff', borderRadius: 12, padding: 24,
          width: '100%', maxWidth: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600, color: 'var(--tc-ink)' }}>
          Choose a Facebook Page
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--tc-ink-faint)' }}>
          You manage multiple Pages — pick which one to connect to this workspace.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pages.map(page => (
            <button
              key={page.id}
              className="btn-ghost sm"
              style={{ justifyContent: 'flex-start', textAlign: 'left', padding: '10px 14px' }}
              disabled={saving !== null}
              onClick={() => handlePick(page)}
            >
              {saving === page.id ? 'Connecting…' : page.name}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="btn-ghost sm" onClick={onClose} disabled={saving !== null}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
