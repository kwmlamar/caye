'use client'

import { useEffect, useState } from 'react'
import SIcon from './SIcon'
import type { CayeHealthResponse } from '@/app/api/caye/health/route'

function formatChannel(c: string): string {
  switch (c) {
    case 'whatsapp': return 'WhatsApp'
    case 'instagram': return 'Instagram'
    case 'messenger': return 'Messenger'
    case 'email': return 'Email'
    case 'sms': return 'SMS'
    default: return c
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      padding: '12px 14px',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 8,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11, color: 'var(--tc-muted, #9aa5b1)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--tc-muted, #9aa5b1)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export default function CayeHealthPanel() {
  const [data, setData] = useState<CayeHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/caye/health', { cache: 'no-store' })
      if (!res.ok) throw new Error(`Health fetch failed: ${res.status}`)
      const json = await res.json() as CayeHealthResponse
      setData(json)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <div className="set-page">
      <header className="set-page-head">
        <div className="ph-left">
          <div className="set-page-eyebrow"><span className="dot"></span>Health</div>
          <h1>Caye health</h1>
          <p className="set-page-desc">
            What Caye has actually been doing in your workspace over the last 7 days.
            Use this to verify the learning system is firing and to spot if she&apos;s holding too much.
          </p>
        </div>
        <div className="ph-right">
          <button className="btn-ghost" onClick={load} disabled={loading}>
            <SIcon name="external" size={14} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && (
        <section className="s-card">
          <div className="s-card-body">
            <div style={{ color: '#e85a3c' }}>Failed to load health data: {error}</div>
          </div>
        </section>
      )}

      {data && (
        <>
          {/* Caye replies */}
          <section className="s-card">
            <div className="s-card-head">
              <div className="h">
                <h3>Caye replies</h3>
                <div className="desc">Auto-replies and holds in the last 7 days, across all channels.</div>
              </div>
            </div>
            <div className="s-card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <Stat label="Auto-replies sent" value={data.caye.caye_auto_replies_7d} />
                <Stat label="Held for human" value={data.caye.caye_holds_7d} />
                <Stat label="Identity-guard blocks" value={data.caye.identity_guard_blocks_7d} />
              </div>
              {data.caye.hold_reasons_top.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 12, color: 'var(--tc-muted, #9aa5b1)', marginBottom: 6 }}>Top hold reasons</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {data.caye.hold_reasons_top.map(r => (
                      <div key={r.reason} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span>{r.reason}</span>
                        <span style={{ color: 'var(--tc-muted, #9aa5b1)' }}>×{r.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Booking actions */}
          <section className="s-card">
            <div className="s-card-head">
              <div className="h">
                <h3>Booking actions by Caye</h3>
                <div className="desc">Detected via the [Caye create/cancel/reschedule] markers on each booking.</div>
              </div>
            </div>
            <div className="s-card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                <Stat label="Created" value={data.bookings.created_by_caye_7d} sub="last 7d" />
                <Stat label="Cancelled" value={data.bookings.cancelled_by_caye_7d} sub="last 7d" />
                <Stat label="Rescheduled" value={data.bookings.rescheduled_by_caye_7d} sub="last 7d" />
                <Stat label="Active total" value={data.bookings.total_active_bookings} sub="all-time" />
              </div>
            </div>
          </section>

          {/* Learning health */}
          <section className="s-card">
            <div className="s-card-head">
              <div className="h">
                <h3>Learning health</h3>
                <div className="desc">Voice profile, customer style profiles, and owner-correction signal.</div>
              </div>
            </div>
            <div className="s-card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <Stat
                  label="Voice profile updated"
                  value={timeAgo(data.learning.voice_profile_updated_at)}
                  sub={data.learning.voice_profile_formality ? `current: ${data.learning.voice_profile_formality}` : 'not yet extracted'}
                />
                <Stat
                  label="Samples since refresh"
                  value={data.learning.owner_messages_since_profile_update}
                  sub="refreshes every 10"
                />
                <Stat
                  label="Corrections (7d)"
                  value={data.learning.owner_corrections_7d}
                  sub="owner overrode Caye"
                />
                <Stat
                  label="Style profiles"
                  value={data.learning.contacts_with_style_profile}
                  sub={`of ${data.learning.total_email_contacts} email contacts`}
                />
              </div>
            </div>
          </section>

          {/* Channels */}
          <section className="s-card">
            <div className="s-card-head">
              <div className="h">
                <h3>Channel activity</h3>
                <div className="desc">Inbound and outbound messages per channel, last 7 days.</div>
              </div>
            </div>
            <div className="s-card-body">
              {data.channels.length === 0 ? (
                <div style={{ color: 'var(--tc-muted, #9aa5b1)', fontSize: 13 }}>No channel activity in the last 7 days.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.channels.map(c => (
                    <div key={c.channel} style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      gap: 16,
                      padding: '8px 0',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      fontSize: 14,
                    }}>
                      <span>{formatChannel(c.channel)}</span>
                      <span style={{ color: 'var(--tc-muted, #9aa5b1)' }}>{c.inbound_7d} in</span>
                      <span style={{ color: 'var(--tc-muted, #9aa5b1)' }}>{c.outbound_7d} out</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <div style={{ fontSize: 11, color: 'var(--tc-muted, #9aa5b1)', marginTop: 16, textAlign: 'right' }}>
            Generated {timeAgo(data.generated_at)}
          </div>
        </>
      )}
    </div>
  )
}
