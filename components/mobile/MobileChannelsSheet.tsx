'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { getSupabase } from '@/lib/supabase'
import MIcon from './MIcon'

interface ChannelDef {
  type: 'whatsapp' | 'messenger' | 'email' | 'instagram'
  name: string
  mark: string
  bg: string
  blurb: string
}

const CHANNELS: ChannelDef[] = [
  { type: 'whatsapp', name: 'WhatsApp Business', mark: 'W', bg: '#22c55e', blurb: 'Guests message you directly on WhatsApp.' },
  { type: 'messenger', name: 'Facebook Messenger', mark: 'M', bg: '#3b82f6', blurb: 'Connect your Facebook Page in one tap.' },
  { type: 'email', name: 'Zoho Mail', mark: '@', bg: '#0d1d24', blurb: 'Caye reads and replies to guest emails.' },
  { type: 'instagram', name: 'Instagram DMs', mark: 'IG', bg: 'linear-gradient(135deg,#f59e0b,#ec4899,#8b5cf6)', blurb: 'Route Instagram DMs into your inbox.' },
]

export default function MobileChannelsSheet({
  workspaceId,
  onClose,
}: {
  workspaceId: string
  onClose: () => void
}) {
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [waOpen, setWaOpen] = useState(false)
  const [waPhone, setWaPhone] = useState('')
  const [waToken, setWaToken] = useState('')
  const [waName, setWaName] = useState('')
  const [waSubmitting, setWaSubmitting] = useState(false)

  useEffect(() => {
    const supabase = getSupabase()
    supabase
      .from('connected_accounts')
      .select('channel_type, is_active')
      .eq('user_id', workspaceId)
      .eq('is_active', true)
      .then(({ data }) => {
        setConnected(new Set((data ?? []).map((a: { channel_type: string }) => a.channel_type)))
        setLoading(false)
      })
  }, [workspaceId])

  const connectEmail = () => {
    window.location.href = `/api/auth/zoho?workspaceId=${workspaceId}`
  }
  const connectMessenger = () => {
    window.location.href = `/api/auth/meta?workspaceId=${workspaceId}`
  }

  const connectWhatsApp = async () => {
    if (!waPhone.trim() || !waToken.trim()) return
    setWaSubmitting(true)
    try {
      const res = await fetch('/api/channels/whatsapp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          phoneNumberId: waPhone.trim(),
          accessToken: waToken.trim(),
          displayName: waName.trim() || undefined,
        }),
      })
      const data = (await res.json()) as { success?: boolean; error?: string }
      if (!res.ok || !data.success) {
        toast.error(data.error ?? 'Connection failed')
        return
      }
      toast.success('WhatsApp connected')
      setConnected(prev => new Set(prev).add('whatsapp'))
      setWaOpen(false)
      setWaPhone('')
      setWaToken('')
      setWaName('')
    } catch {
      toast.error('Connection failed')
    } finally {
      setWaSubmitting(false)
    }
  }

  return (
    <div className="m-sheet">
      <div className="m-sheet-head">
        <button className="m-sheet-back" onClick={onClose} aria-label="Back">
          <MIcon name="chevL" size={18} />
        </button>
        <h2>Connect channels</h2>
      </div>

      <div className="m-sheet-body">
        <div className="m-sheet-intro">
          Every channel you connect funnels into the same inbox — Caye replies on all of them.
        </div>

        {CHANNELS.map(ch => {
          const isOn = connected.has(ch.type)
          return (
            <div className="m-chan-card" key={ch.type}>
              <div className="m-chan-row">
                <span className="m-chan-mark" style={{ background: ch.bg }}>
                  {ch.mark}
                </span>
                <div className="m-chan-info">
                  <div className="m-chan-name">{ch.name}</div>
                  <div className={'m-chan-status' + (isOn ? ' on' : '')}>
                    {loading ? 'Checking…' : isOn ? 'Connected' : ch.blurb}
                  </div>
                </div>

                {isOn ? (
                  <button className="m-chan-btn connected" disabled>
                    Connected
                  </button>
                ) : ch.type === 'instagram' ? (
                  <button className="m-chan-btn soon" disabled>
                    Soon
                  </button>
                ) : ch.type === 'email' ? (
                  <button className="m-chan-btn" onClick={connectEmail}>
                    Connect
                  </button>
                ) : ch.type === 'messenger' ? (
                  <button className="m-chan-btn" onClick={connectMessenger}>
                    Connect
                  </button>
                ) : (
                  <button className="m-chan-btn" onClick={() => setWaOpen(o => !o)}>
                    {waOpen ? 'Close' : 'Connect'}
                  </button>
                )}
              </div>

              {ch.type === 'whatsapp' && waOpen && !isOn && (
                <div className="m-chan-form">
                  <input
                    placeholder="Phone Number ID"
                    value={waPhone}
                    onChange={e => setWaPhone(e.target.value)}
                  />
                  <input
                    placeholder="Permanent access token"
                    type="password"
                    value={waToken}
                    onChange={e => setWaToken(e.target.value)}
                  />
                  <input
                    placeholder="Display name (optional)"
                    value={waName}
                    onChange={e => setWaName(e.target.value)}
                  />
                  <span className="hint">From Meta Business Suite → WhatsApp → API Setup.</span>
                  <button
                    className="btn-pri coral"
                    style={{ width: '100%' }}
                    disabled={waSubmitting || !waPhone.trim() || !waToken.trim()}
                    onClick={connectWhatsApp}
                  >
                    <MIcon name="tick" size={14} /> {waSubmitting ? 'Connecting…' : 'Connect WhatsApp'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
