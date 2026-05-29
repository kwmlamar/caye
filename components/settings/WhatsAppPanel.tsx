'use client'

import { useEffect, useState, useCallback } from 'react'
import { getSupabase } from '@/lib/supabase'

interface WhatsAppConfig {
  operatorNumber: string | null
  verifiedAt: string | null
  quietStart: string
  quietEnd: string
  mutedUntil: string | null
  unreachable: boolean
  blocked: boolean
  failureStreak: number
  lastOutboundStatus: string | null
  lastInboundAt: string | null
  outboundEnabled: boolean
}

interface ActivityRow {
  id: string
  kind: string
  status: string
  sent_at: string | null
  created_at: string
  last_error: string | null
}

const MUTE_OPTIONS: { label: string; hours: number | null }[] = [
  { label: 'Not muted', hours: 0 },
  { label: 'Mute 2 hours', hours: 2 },
  { label: 'Mute 8 hours', hours: 8 },
  { label: 'Mute 24 hours', hours: 24 },
  { label: 'Mute 48 hours', hours: 48 },
]

export default function WhatsAppPanel() {
  const [cfg, setCfg] = useState<WhatsAppConfig | null>(null)
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [savingMute, setSavingMute] = useState(false)
  const [quietStart, setQuietStart] = useState('21:00')
  const [quietEnd, setQuietEnd] = useState('07:00')
  const [savingQuiet, setSavingQuiet] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = getSupabase()
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined

      const [cfgRes, actRes] = await Promise.all([
        fetch('/api/caye/whatsapp/config', { headers }),
        fetch('/api/caye/whatsapp/activity', { headers }),
      ])
      if (cfgRes.ok) {
        const data: WhatsAppConfig = await cfgRes.json()
        setCfg(data)
        setQuietStart(data.quietStart)
        setQuietEnd(data.quietEnd)
      }
      if (actRes.ok) {
        const data = await actRes.json()
        setActivity(data.rows ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  async function patch(body: Record<string, unknown>): Promise<void> {
    const supabase = getSupabase()
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const token = session?.access_token
    await fetch('/api/caye/whatsapp/config', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  async function setMute(hours: number | null) {
    setSavingMute(true)
    try {
      const mutedUntil =
        hours === null || hours === 0 ? null : new Date(Date.now() + hours * 3600 * 1000).toISOString()
      await patch({ mutedUntil })
      await reload()
    } finally {
      setSavingMute(false)
    }
  }

  async function saveQuiet() {
    setSavingQuiet(true)
    try {
      await patch({ quietStart, quietEnd })
      await reload()
    } finally {
      setSavingQuiet(false)
    }
  }

  if (loading) {
    return (
      <div className="set-page">
        <p style={{ color: 'var(--tc-ink-faint)', fontSize: 12 }}>Loading…</p>
      </div>
    )
  }
  if (!cfg) return null

  const muteStatus = cfg.mutedUntil
    ? `Muted until ${new Date(cfg.mutedUntil).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`
    : 'Not muted'
  const verifiedLine = cfg.verifiedAt
    ? `Verified ${new Date(cfg.verifiedAt).toLocaleDateString()}`
    : 'Not verified yet'

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow">
            <span className="dot"></span>WhatsApp messaging
          </div>
          <h1>How Caye reaches you</h1>
          <p className="set-page-desc">
            Caye DMs you on WhatsApp when something needs your call. One number, your personal account.
          </p>
        </div>
      </header>

      {/* Operator number */}
      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Your number</h3>
            <div className="desc">{verifiedLine}</div>
          </div>
        </div>
        <div className="s-card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>
            {cfg.operatorNumber ?? '— not set —'}
          </div>
          <button
            className="btn-ghost sm"
            onClick={() => {
              // Re-verify by re-opening the OTP modal flow on the home checklist.
              window.location.href = `/dashboard`
            }}
          >
            {cfg.operatorNumber ? 'Re-verify' : 'Connect'}
          </button>
        </div>
      </section>

      {/* Mute */}
      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Mute Caye</h3>
            <div className="desc">{muteStatus}. Auth failures still ping during a mute.</div>
          </div>
        </div>
        <div className="s-card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {MUTE_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              className="btn-ghost sm"
              disabled={savingMute}
              onClick={() => setMute(opt.hours)}
              style={{
                opacity: savingMute ? 0.5 : 1,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {/* Quiet hours */}
      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Quiet hours</h3>
            <div className="desc">
              Caye holds non-urgent pings during this window and flushes them at the end.
            </div>
          </div>
        </div>
        <div className="s-card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--tc-ink-faint)' }}>
            From
            <input
              type="time"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
              style={{
                marginLeft: 8,
                padding: '4px 8px',
                fontSize: 13,
                borderRadius: 6,
                border: '1px solid var(--tc-line, #e5e5e5)',
              }}
            />
          </label>
          <label style={{ fontSize: 12, color: 'var(--tc-ink-faint)' }}>
            To
            <input
              type="time"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
              style={{
                marginLeft: 8,
                padding: '4px 8px',
                fontSize: 13,
                borderRadius: 6,
                border: '1px solid var(--tc-line, #e5e5e5)',
              }}
            />
          </label>
          <button className="btn-ghost sm" onClick={saveQuiet} disabled={savingQuiet}>
            {savingQuiet ? 'Saving…' : 'Save'}
          </button>
        </div>
      </section>

      {/* Activity log */}
      <section className="s-card">
        <div className="s-card-head">
          <div className="h">
            <h3>Recent activity</h3>
            <div className="desc">Last 50 outbound messages to your phone.</div>
          </div>
        </div>
        <div className="s-card-body">
          {activity.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--tc-ink-faint)' }}>Nothing yet.</p>
          ) : (
            <table style={{ width: '100%', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--tc-ink-faint)' }}>
                  <th style={{ padding: '4px 8px' }}>When</th>
                  <th style={{ padding: '4px 8px' }}>Kind</th>
                  <th style={{ padding: '4px 8px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--tc-line, #f0f0f0)' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                      {new Date(r.sent_at ?? r.created_at).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{r.kind}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <StatusPill status={r.status} />
                      {r.last_error && (
                        <span style={{ color: 'var(--tc-ink-faint)', marginLeft: 6 }}>
                          {r.last_error.slice(0, 60)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'sent'
      ? '#0FB5A1'
      : status === 'failed' || status === 'dead_letter'
      ? '#D9534F'
      : status === 'cancelled'
      ? '#888'
      : '#C9A227'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 4,
        background: `${color}22`,
        color,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  )
}
