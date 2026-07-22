'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import type { CustomerStatus } from '@/types/database'

const CARD_BG = '#121214'
const CARD_BORDER = '#1f1f23'
const LABEL_COLOR = '#71717a'

const STATUS_LABEL: Record<CustomerStatus, string> = {
  active: 'Live',
  trial: 'Trial',
  inactive: 'Dormant',
  suspended: 'Blocked',
}
const STATUS_COLOR: Record<CustomerStatus, string> = {
  active: '#34d399',
  trial: '#FFD68F',
  inactive: '#71717a',
  suspended: '#fb7185',
}

function StatusPill({ status }: { status: CustomerStatus }) {
  const color = STATUS_COLOR[status]
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
      color, background: `${color}1a`, border: `1px solid ${color}33`,
      borderRadius: 999, padding: '2px 8px', flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', gap: 5,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      {STATUS_LABEL[status]}
    </span>
  )
}

interface WorkspaceRow {
  workspace_id: string
  business_name: string
  status: CustomerStatus
  call_count: number
  cost_usd: number
  conversations_30d: number
  bookings_30d: number
  conversion_rate: number | null
}

interface DailyPoint {
  day: string
  cost_usd: number
  calls: number
  conversations: number
  bookings: number
}

function fmtConversionRate(rate: number | null): string {
  if (rate === null) return '—'
  return `${Math.round(rate * 100)}%`
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function DailyCostChart({ daily }: { daily: DailyPoint[] }) {
  const max = Math.max(...daily.map((d) => d.cost_usd), 0.0001)
  const total = daily.reduce((acc, d) => acc + d.cost_usd, 0)
  const totalCalls = daily.reduce((acc, d) => acc + d.calls, 0)

  return (
    <div style={{ padding: '14px 16px 16px' }}>
      <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>30-day cost</div>
          <div style={{ fontSize: 15, fontFamily: 'var(--font-display)', fontWeight: 600 }}>${total.toFixed(2)}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>30-day calls</div>
          <div style={{ fontSize: 15, fontFamily: 'var(--font-display)', fontWeight: 600 }}>{totalCalls.toLocaleString()}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>Avg $/call</div>
          <div style={{ fontSize: 15, fontFamily: 'var(--font-display)', fontWeight: 600 }}>
            {totalCalls > 0 ? `$${(total / totalCalls).toFixed(4)}` : '—'}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 70 }}>
        {daily.map((d) => (
          <div
            key={d.day}
            title={`${fmtDay(d.day)} — $${d.cost_usd.toFixed(4)} · ${d.calls} call${d.calls === 1 ? '' : 's'}`}
            style={{
              flex: 1, minWidth: 2,
              height: `${Math.max((d.cost_usd / max) * 100, d.cost_usd > 0 ? 4 : 1)}%`,
              background: d.cost_usd > 0 ? '#7DC9CB' : 'rgba(255,255,255,0.06)',
              borderRadius: '2px 2px 0 0',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: LABEL_COLOR }}>
        <span>{fmtDay(daily[0].day)}</span>
        <span>{fmtDay(daily[daily.length - 1].day)}</span>
      </div>
    </div>
  )
}

// Conversations vs. bookings, same 30-day window as the cost chart.
// This is a volume ratio (bookings that happened ÷ conversations that
// happened in the period), not per-thread attribution — most bookings
// (Zoho Calendar syncs) aren't linked to the conversation that produced
// them, so a strict funnel would wildly undercount. Founder-facing
// caption says so explicitly since this is the number that gets shown
// to a customer as ROI proof.
function ConversionTrendChart({ daily }: { daily: DailyPoint[] }) {
  const totalConversations = daily.reduce((acc, d) => acc + d.conversations, 0)
  const totalBookings = daily.reduce((acc, d) => acc + d.bookings, 0)
  const rate = totalConversations > 0 ? totalBookings / totalConversations : null
  const max = Math.max(...daily.map((d) => Math.max(d.conversations, d.bookings)), 1)

  return (
    <div style={{ padding: '4px 16px 16px', borderTop: `1px solid ${CARD_BORDER}` }}>
      <div style={{ display: 'flex', gap: 20, margin: '10px 0 12px' }}>
        <div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>30-day conversations</div>
          <div style={{ fontSize: 15, fontFamily: 'var(--font-display)', fontWeight: 600 }}>{totalConversations.toLocaleString()}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>30-day bookings</div>
          <div style={{ fontSize: 15, fontFamily: 'var(--font-display)', fontWeight: 600 }}>{totalBookings.toLocaleString()}</div>
        </div>
        <div>
          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR }}>Conversion rate</div>
          <div style={{ fontSize: 15, fontFamily: 'var(--font-display)', fontWeight: 600, color: '#FFD68F' }}>{fmtConversionRate(rate)}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 60 }}>
        {daily.map((d) => (
          <div key={d.day} title={`${fmtDay(d.day)} — ${d.conversations} conversation${d.conversations === 1 ? '' : 's'}, ${d.bookings} booking${d.bookings === 1 ? '' : 's'}`}
            style={{ flex: 1, minWidth: 2, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 1, height: '100%' }}>
            <div style={{ height: `${Math.max((d.conversations / max) * 100, d.conversations > 0 ? 4 : 1)}%`, background: 'rgba(255,255,255,0.12)', borderRadius: '2px 2px 0 0' }} />
            <div style={{ height: `${Math.max((d.bookings / max) * 100, d.bookings > 0 ? 4 : 1)}%`, background: '#FFD68F', borderRadius: '2px 2px 0 0' }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: LABEL_COLOR }}>
        <span>{fmtDay(daily[0].day)}</span>
        <span>{fmtDay(daily[daily.length - 1].day)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: LABEL_COLOR }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: 'rgba(255,255,255,0.12)' }} /> Conversations
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: '#FFD68F' }} /> Bookings
        </span>
      </div>
      <div style={{ marginTop: 8, fontSize: 10.5, color: '#52525b', lineHeight: 1.4 }}>
        Volume ratio, not a per-conversation funnel — most bookings sync in from the operator&apos;s calendar rather than a tracked Caye thread.
      </div>
    </div>
  )
}

// Cross-workspace cost + usage monitor — one row per workspace the
// founder has access to, real 7-day LLM API cost and call volume from
// llm_call_log. No revenue/margin column: customers.plan and
// stripe_subscription_id aren't reliably populated per workspace, so
// showing a fake number would be worse than showing none. Read-only —
// no actions here, act via Caye Direct / Command Conversations instead.
// Clicking a row expands an inline 30-day daily-cost trend in place,
// rather than navigating away and losing the cross-workspace table.
export default function GlobalPerformance() {
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, DailyPoint[] | 'loading' | 'error'>>({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/global-performance', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (cancelled) return
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setRows(json.workspaces ?? [])
    }
    load()
    return () => { cancelled = true }
  }, [])

  async function toggleRow(workspaceId: string) {
    if (expandedId === workspaceId) { setExpandedId(null); return }
    setExpandedId(workspaceId)
    if (detailCache[workspaceId]) return
    setDetailCache((prev) => ({ ...prev, [workspaceId]: 'loading' }))
    const { session } = await getSession()
    if (!session) return
    const res = await fetch(`/api/founder/global-performance?detailWorkspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const json = await res.json()
    setDetailCache((prev) => ({ ...prev, [workspaceId]: res.ok ? json.daily : 'error' }))
  }

  const totalCost = rows?.reduce((acc, r) => acc + r.cost_usd, 0) ?? 0
  const totalCalls = rows?.reduce((acc, r) => acc + r.call_count, 0) ?? 0

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <div style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <div style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 18, padding: '16px 18px' }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
            Workspaces
          </div>
          <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {rows?.length ?? '—'}
          </div>
        </div>
        <div style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 18, padding: '16px 18px' }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
            7-day calls (all workspaces)
          </div>
          <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {rows ? totalCalls.toLocaleString() : '—'}
          </div>
        </div>
        <div style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 18, padding: '16px 18px' }}>
          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, marginBottom: 8 }}>
            7-day cost (all workspaces)
          </div>
          <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {rows ? `$${totalCost.toFixed(2)}` : '—'}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '20px 1fr 110px 130px 130px 110px',
          padding: '10px 16px', borderBottom: `1px solid ${CARD_BORDER}`,
          fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: LABEL_COLOR,
        }}>
          <span />
          <span>Workspace</span>
          <span>Status</span>
          <span style={{ textAlign: 'right' }}>7-day calls</span>
          <span style={{ textAlign: 'right' }}>7-day cost</span>
          <span style={{ textAlign: 'right' }}>Conv. rate (30d)</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {error ? (
            <div style={{ padding: 16, fontSize: 12.5, color: '#fb7185' }}>{error}</div>
          ) : rows === null ? (
            <div style={{ padding: 16 }}><CayeLoadingPulse size={16} /></div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12.5, color: '#52525b' }}>No workspaces.</div>
          ) : (
            rows.map((r) => {
              const isOpen = expandedId === r.workspace_id
              const detail = detailCache[r.workspace_id]
              return (
                <div key={r.workspace_id} style={{ borderBottom: `1px solid ${CARD_BORDER}` }}>
                  <button
                    onClick={() => toggleRow(r.workspace_id)}
                    style={{
                      display: 'grid', gridTemplateColumns: '20px 1fr 110px 130px 130px 110px', width: '100%',
                      padding: '11px 16px', border: 'none',
                      background: isOpen ? 'rgba(125,201,203,0.05)' : 'transparent', cursor: 'pointer', textAlign: 'left', alignItems: 'center',
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#71717a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}>
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#f4f4f5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8 }}>
                      {r.business_name}
                    </span>
                    <StatusPill status={r.status} />
                    <span style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#a1a1aa' }}>
                      {r.call_count.toLocaleString()}
                    </span>
                    <span style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      ${r.cost_usd.toFixed(2)}
                    </span>
                    <span
                      title={`${r.bookings_30d} booking${r.bookings_30d === 1 ? '' : 's'} / ${r.conversations_30d} conversation${r.conversations_30d === 1 ? '' : 's'}, last 30 days`}
                      style={{ fontSize: 13, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: r.conversion_rate === null ? '#52525b' : '#FFD68F' }}
                    >
                      {fmtConversionRate(r.conversion_rate)}
                    </span>
                  </button>
                  {isOpen && (
                    <div style={{ borderTop: `1px solid ${CARD_BORDER}`, background: 'rgba(255,255,255,0.02)' }}>
                      {detail === 'loading' || detail === undefined ? (
                        <div style={{ padding: 16 }}><CayeLoadingPulse label="Loading trend…" size={14} /></div>
                      ) : detail === 'error' ? (
                        <div style={{ padding: 16, fontSize: 12, color: '#fb7185' }}>Failed to load trend.</div>
                      ) : (
                        <>
                          <DailyCostChart daily={detail} />
                          <ConversionTrendChart daily={detail} />
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
