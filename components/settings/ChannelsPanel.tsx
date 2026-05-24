'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

declare global {
  interface Window {
    FB: {
      init: (opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void
      login: (
        callback: (response: { authResponse?: { code?: string; accessToken?: string } | null; status?: string }) => void,
        opts: {
          config_id: string
          response_type: string
          override_default_response_type: boolean
          extras?: { setup?: object; featureType?: string; sessionInfoVersion?: string }
        }
      ) => void
    }
    fbAsyncInit: () => void
  }
}
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
  sync_calendar: boolean | null
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
    note: 'Connect your Instagram account to route DMs into the Caye inbox.',
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
  const [whatsappPages, setWhatsappPages] = useState<{ id: string; name: string; token: string; display_phone_number: string }[] | null>(null)
  const [messengerPages, setMessengerPages] = useState<{ id: string; name: string; token: string }[] | null>(null)
  const [instagramPages, setInstagramPages] = useState<{ id: string; name: string; token: string }[] | null>(null)
  const [whatsappConnecting, setWhatsappConnecting] = useState(false)
  const searchParams = useSearchParams()
  const router = useRouter()
  const fbSdkLoaded = useRef(false)

  useEffect(() => {
    const zohoConnected = searchParams.get('zoho_connected')
    const zohoError = searchParams.get('zoho_error')
    const msgrConnected = searchParams.get('messenger_connected')
    const msgrError = searchParams.get('messenger_error')
    const msgrPages = searchParams.get('messenger_pages')
    const instagramConnected = searchParams.get('instagram_connected')
    const instagramError = searchParams.get('instagram_error')
    const instagramPagesParam = searchParams.get('instagram_pages')
    const whatsappConnected = searchParams.get('whatsapp_connected')
    const whatsappError = searchParams.get('whatsapp_error')
    const whatsappPagesParam = searchParams.get('whatsapp_pages')

    if (zohoConnected === '1') toast.success('Zoho Mail connected')
    else if (zohoError === 'access_denied') toast.error('Zoho authorization was denied')
    else if (zohoError) toast.error(`Zoho connection failed (${zohoError})`)

    if (msgrConnected === '1') { toast.success('Messenger connected'); fetchAccounts() }
    else if (msgrError === 'access_denied') toast.error('Facebook authorization was denied')
    else if (msgrError === 'no_pages') toast.error('No Facebook Pages found — make sure you manage at least one Page')
    else if (msgrError) toast.error(`Messenger connection failed (${msgrError})`)

    if (instagramConnected === '1') { toast.success('Instagram DMs connected'); fetchAccounts() }
    else if (instagramError === 'access_denied') toast.error('Facebook authorization was denied')
    else if (instagramError === 'no_instagram_accounts') toast.error('No linked Instagram Business Accounts found — make sure your Instagram account is linked to your Facebook Page')
    else if (instagramError) toast.error(`Instagram connection failed (${instagramError})`)

    if (whatsappConnected === '1') { toast.success('WhatsApp connected'); fetchAccounts() }
    else if (whatsappError === 'access_denied') toast.error('Facebook authorization was denied')
    else if (whatsappError === 'no_whatsapp_accounts') toast.error('No WhatsApp phone numbers found in your Meta Business account')
    else if (whatsappError) toast.error(`WhatsApp connection failed (${whatsappError})`)

    if (msgrPages) {
      try {
        // Use atob (Web API) instead of Buffer (Node.js) for client-side decoding
        const base64 = msgrPages.replace(/-/g, '+').replace(/_/g, '/')
        const decoded = JSON.parse(atob(base64))
        setMessengerPages(decoded)
      } catch (e) { console.error('[ChannelsPanel] Failed to decode messenger_pages:', e) }
    }

    if (instagramPagesParam) {
      try {
        const base64 = instagramPagesParam.replace(/-/g, '+').replace(/_/g, '/')
        const decoded = JSON.parse(atob(base64))
        setInstagramPages(decoded)
      } catch (e) { console.error('[ChannelsPanel] Failed to decode instagram_pages:', e) }
    }

    if (whatsappPagesParam) {
      try {
        const base64 = whatsappPagesParam.replace(/-/g, '+').replace(/_/g, '/')
        const decoded = JSON.parse(atob(base64))
        setWhatsappPages(decoded)
      } catch (e) { console.error('[ChannelsPanel] Failed to decode whatsapp_pages:', e) }
    }

    // Strip the one-time params so they don't re-fire on refresh
    const clean = new URLSearchParams(searchParams.toString())
    clean.delete('zoho_connected'); clean.delete('zoho_error')
    clean.delete('messenger_connected'); clean.delete('messenger_error'); clean.delete('messenger_pages')
    clean.delete('instagram_connected'); clean.delete('instagram_error'); clean.delete('instagram_pages')
    clean.delete('whatsapp_connected'); clean.delete('whatsapp_error'); clean.delete('whatsapp_pages')
    router.replace(`?${clean.toString()}`)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load the Meta JS SDK once so FB.login() is available for Embedded Signup
  useEffect(() => {
    if (fbSdkLoaded.current || document.getElementById('facebook-jssdk')) {
      fbSdkLoaded.current = true
      return
    }
    window.fbAsyncInit = () => {
      window.FB.init({
        appId: process.env.NEXT_PUBLIC_META_APP_ID!,
        autoLogAppEvents: true,
        xfbml: true,
        version: 'v19.0',
      })
      fbSdkLoaded.current = true
    }
    const script = document.createElement('script')
    script.id = 'facebook-jssdk'
    script.src = 'https://connect.facebook.net/en_US/sdk.js'
    script.async = true
    script.defer = true
    document.body.appendChild(script)
  }, [])

  const fetchAccounts = useCallback(async () => {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('connected_accounts')
      .select('id, channel_type, channel_account_name, channel_username, channel_account_id, is_active, needs_reauth, sync_calendar, created_at')
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

  // Listen for Meta's postMessage events from the Embedded Signup popup.
  // This fires regardless of whether FB.login()'s callback gets a code, and
  // tells us if the user finished, cancelled, or hit an error in the popup.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return
        console.log('[WhatsApp ES] postMessage event:', data)
        if (data.event === 'CANCEL' || data.event === 'ERROR') {
          setWhatsappConnecting(false)
          toast.error(data.event === 'CANCEL' ? 'WhatsApp signup cancelled' : `WhatsApp signup error: ${data.data?.error_message ?? 'unknown'}`)
        }
      } catch (err) {
        console.warn('[WhatsApp ES] failed to parse postMessage:', err)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const launchWhatsAppSignup = useCallback(() => {
    const configId = process.env.NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID
    console.log('[WhatsApp ES] launch — configId:', configId, 'FB loaded:', !!window.FB)
    if (!configId) {
      toast.error('WhatsApp Embedded Signup config ID not set — check NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID')
      return
    }
    if (!window.FB) {
      toast.error('Meta SDK not loaded yet — please try again in a moment')
      return
    }
    setWhatsappConnecting(true)
    const timeout = setTimeout(() => {
      console.warn('[WhatsApp ES] timeout — FB.login callback never fired')
      setWhatsappConnecting(false)
    }, 120000)
    // FB SDK explicitly rejects async functions as callbacks — wrap in a
    // sync function that invokes an async IIFE.
    window.FB.login(
      (response) => {
        clearTimeout(timeout)
        console.log('[WhatsApp ES] FB.login callback:', response)
        if (!response.authResponse?.code) {
          setWhatsappConnecting(false)
          toast.error('WhatsApp authorization was cancelled')
          return
        }
        const code = response.authResponse.code
        ;(async () => {
          try {
            const res = await fetch('/api/auth/meta/whatsapp-embedded', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code, workspaceId }),
            })
            const data = await res.json() as { success?: boolean; phoneNumbers?: { id: string; name: string; token: string; display_phone_number: string }[]; error?: string }
            console.log('[WhatsApp ES] backend response:', data)
            if (!res.ok || !data.success) {
              toast.error(data.error ?? 'WhatsApp connection failed')
              return
            }
            if (data.phoneNumbers && data.phoneNumbers.length > 1) {
              setWhatsappPages(data.phoneNumbers)
            } else if (data.phoneNumbers?.length === 1) {
              toast.success(`WhatsApp connected — ${data.phoneNumbers[0].display_phone_number}`)
              fetchAccounts()
            }
          } catch (err) {
            console.error('[WhatsApp ES] backend fetch failed:', err)
            toast.error('WhatsApp connection failed')
          } finally {
            setWhatsappConnecting(false)
          }
        })()
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        // Meta requires sessionInfoVersion to actually launch the Embedded Signup popup
        extras: {
          setup: {},
          featureType: '',
          sessionInfoVersion: '3',
        },
      }
    )
  }, [workspaceId, fetchAccounts])

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
            Every connected channel funnels into the same Caye inbox. Caye AI replies on all connected channels by default.
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
                    {type === 'email' && account && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!account.sync_calendar}
                          onChange={async (e) => {
                            const next = e.target.checked
                            const supabase = getSupabase()
                            const { error } = await supabase
                              .from('connected_accounts')
                              .update({ sync_calendar: next })
                              .eq('id', account.id)
                            if (error) { toast.error('Failed to update sync setting'); return }
                            toast.success(next ? 'Calendar sync enabled' : 'Calendar sync disabled')
                            fetchAccounts()
                          }}
                        />
                        <span>Mirror Caye bookings to my Zoho Calendar</span>
                      </label>
                    )}
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
                        launchWhatsAppSignup()
                      } else if (type === 'messenger') {
                        window.location.href = `/api/auth/meta?workspaceId=${workspaceId}&channel=messenger`
                      } else if (type === 'instagram') {
                        window.location.href = `/api/auth/meta?workspaceId=${workspaceId}&channel=instagram`
                      }
                    }}
                    disabled={(type !== 'email' && type !== 'whatsapp' && type !== 'messenger' && type !== 'instagram') || (type === 'whatsapp' && whatsappConnecting)}
                    title={type !== 'email' && type !== 'whatsapp' && type !== 'messenger' && type !== 'instagram' ? 'Coming soon' : undefined}
                  >
                    <SIcon name="plus" size={12} />
                    {type === 'whatsapp' && whatsappConnecting ? 'Connecting…' : needsReauth ? 'Reconnect' : 'Connect'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {whatsappPages && workspaceId && (
        <WhatsAppPagePicker
          pages={whatsappPages}
          workspaceId={workspaceId}
          onSuccess={() => { setWhatsappPages(null); fetchAccounts() }}
          onClose={() => setWhatsappPages(null)}
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

      {instagramPages && workspaceId && (
        <InstagramPagePicker
          pages={instagramPages}
          workspaceId={workspaceId}
          onSuccess={() => { setInstagramPages(null); fetchAccounts() }}
          onClose={() => setInstagramPages(null)}
        />
      )}
    </div>
  )
}

function WhatsAppPagePicker({ pages, workspaceId, onSuccess, onClose }: {
  pages: { id: string; name: string; token: string; display_phone_number: string }[]
  workspaceId: string
  onSuccess: () => void
  onClose: () => void
}) {
  const [saving, setSaving] = useState<string | null>(null)

  const handlePick = async (page: { id: string; name: string; token: string; display_phone_number: string }) => {
    setSaving(page.id)
    try {
      const res = await fetch('/api/channels/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, phoneNumberId: page.id, accessToken: page.token, displayName: page.name }),
      })
      const data = await res.json() as { success?: boolean; error?: string }
      if (!res.ok || !data.success) { toast.error(data.error ?? 'Connection failed'); return }
      toast.success(`WhatsApp connected — ${page.display_phone_number}`)
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
          Choose a WhatsApp Account
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--tc-ink-faint)' }}>
          Multiple WhatsApp phone numbers found — pick which one to connect to this workspace.
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
              {saving === page.id ? 'Connecting…' : `${page.name} (${page.display_phone_number})`}
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

function InstagramPagePicker({ pages, workspaceId, onSuccess, onClose }: {
  pages: { id: string; name: string; token: string }[]
  workspaceId: string
  onSuccess: () => void
  onClose: () => void
}) {
  const [saving, setSaving] = useState<string | null>(null)

  const handlePick = async (page: { id: string; name: string; token: string }) => {
    setSaving(page.id)
    try {
      const res = await fetch('/api/channels/instagram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, instagramBusinessId: page.id, accessToken: page.token, instagramName: page.name }),
      })
      const data = await res.json() as { success?: boolean; error?: string }
      if (!res.ok || !data.success) { toast.error(data.error ?? 'Connection failed'); return }
      toast.success(`Instagram DMs connected — ${page.name}`)
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
          Choose an Instagram Account
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--tc-ink-faint)' }}>
          Multiple Instagram Business Accounts found — pick which one to connect to this workspace.
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
