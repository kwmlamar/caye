'use client'

import type { ReactNode } from 'react'
import type { Booking } from '@/lib/useCommandOverview'

// Same dark-console tokens as FounderHome.tsx — kept local rather than
// imported since FounderHome doesn't export them (matches the pattern
// already used by GlobalPerformance.tsx / ContactsPanel.tsx).
const CARD_BORDER = '#1f1f23'
const LABEL_COLOR = '#71717a'
const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

// Booking status → the accent color it renders with. Nothing distinguished
// these before this pass — every booking looked identical regardless of
// whether the customer had actually confirmed.
const STATUS_COLOR: Record<string, string> = {
  confirmed: '#7DC9CB',
  pending: '#FFD68F',
  completed: '#52525b',
}
const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  completed: 'Completed',
}

function fmtTime(t: string): string {
  const [h, m] = t.split(':')
  return `${h}:${m}`
}

function fmtDayMonth(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? LABEL_COLOR
  return <span title={STATUS_LABEL[status] ?? status} style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
}

function PaidBadge() {
  return (
    <span title="Payment confirmed" style={{ display: 'inline-flex', flexShrink: 0 }}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  )
}

function EscalationDot() {
  return <span title="Open escalation — waiting on you" style={{ width: 6, height: 6, borderRadius: '50%', background: '#fb7185', boxShadow: '0 0 0 2px rgba(251,113,133,0.25)', flexShrink: 0 }} />
}

function NavButton({ onClick, disabled, children, title }: { onClick: () => void; disabled?: boolean; children: ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 6, border: `1px solid ${CARD_BORDER}`, background: 'rgba(255,255,255,0.03)',
        color: disabled ? '#3f3f46' : '#a1a1aa', cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {children}
    </button>
  )
}

interface Props {
  bookings: Booking[]
  weekStart: string // YYYY-MM-DD, Monday
  weekOffset: number
  onWeekOffsetChange: (offset: number) => void
  onSelectConversation?: (conversationId: string) => void
}

export default function CommandCalendar({ bookings, weekStart, weekOffset, onWeekOffsetChange, onSelectConversation }: Props) {
  const todayIso = new Date().toISOString().slice(0, 10)
  const parsed = new Date(`${weekStart}T00:00:00Z`)
  const monday = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)

  const week = DAY_LABELS.map((label, i) => {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() + i)
    const iso = d.toISOString().slice(0, 10)
    return {
      label,
      date: d.getUTCDate(),
      isToday: iso === todayIso,
      bookings: bookings.filter((b) => b.booking_date === iso),
    }
  })

  function handleBookingClick(b: Booking) {
    if (b.conversation_id && onSelectConversation) onSelectConversation(b.conversation_id)
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20, color: '#f5f5f4', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingRight: 36 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.06em', color: LABEL_COLOR }}>SOURCE CALENDAR</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#7DC9CB', background: 'rgba(125,201,203,0.1)', border: '1px solid rgba(125,201,203,0.3)', borderRadius: 999, padding: '2px 8px' }}>
              SYNCED
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'rgba(245,245,244,0.4)', marginTop: 4 }}>
            {fmtDayMonth(monday)} – {fmtDayMonth(sunday)}{weekOffset === 0 && <span style={{ color: '#7DC9CB' }}> · this week</span>}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <NavButton title="Previous week" onClick={() => onWeekOffsetChange(weekOffset - 1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </NavButton>
          {weekOffset !== 0 && (
            <button
              onClick={() => onWeekOffsetChange(0)}
              style={{
                height: 24, padding: '0 10px', fontSize: 10.5, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em',
                borderRadius: 6, border: `1px solid ${CARD_BORDER}`, background: 'rgba(255,255,255,0.03)', color: '#a1a1aa', cursor: 'pointer',
              }}
            >
              Today
            </button>
          )}
          <NavButton title="Next week" onClick={() => onWeekOffsetChange(weekOffset + 1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </NavButton>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: week.map((d) => (d.isToday ? '1.7fr' : '1fr')).join(' '), gap: 6, flex: 1, minHeight: 0 }}>
        {week.map((d) => (
          <div key={d.label} style={{
            position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column',
            background: d.isToday ? 'rgba(125,201,203,0.07)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${d.isToday ? 'rgba(125,201,203,0.4)' : 'rgba(255,255,255,0.07)'}`,
            borderRadius: 10, padding: d.isToday ? 10 : 8,
          }}>
            {d.isToday && <div aria-hidden style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: GRADIENT }} />}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: d.isToday ? '#7DC9CB' : '#71717a', letterSpacing: '0.06em' }}>{d.label}</span>
              <span style={{ fontSize: d.isToday ? 15 : 13, fontFamily: 'var(--font-display)', fontWeight: 600 }}>{d.date}</span>
              {d.isToday && <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: '#7DC9CB', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Today</span>}
            </div>

            {d.bookings.length === 0 ? (
              <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.25)' }}>no bookings</div>
            ) : d.isToday ? (
              // Today gets the full detail: time, customer, tour, guests,
              // status/payment/escalation — the "what needs handling right
              // now" surface the founder actually checks.
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
                {d.bookings.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => handleBookingClick(b)}
                    disabled={!b.conversation_id}
                    style={{
                      textAlign: 'left', border: `1px solid ${CARD_BORDER}`, background: 'rgba(255,255,255,0.04)',
                      borderRadius: '3px 8px 8px 8px', padding: '7px 9px', cursor: b.conversation_id ? 'pointer' : 'default',
                      borderLeft: `2px solid ${STATUS_COLOR[b.status] ?? LABEL_COLOR}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'rgba(245,245,244,0.5)' }}>{b.booking_time ? fmtTime(b.booking_time) : '—'}</span>
                      <StatusDot status={b.status} />
                      {b.payment_confirmed && <PaidBadge />}
                      {b.has_open_escalation && <EscalationDot />}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.customer_name}</div>
                    <div style={{ fontSize: 10, color: 'rgba(245,245,244,0.4)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {b.service_name ?? 'Tour'} · {b.number_of_people} guest{b.number_of_people === 1 ? '' : 's'}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              // Other days stay compact: at most 3 shown, name + status dot
              // only, "+N more" instead of pushing the row taller.
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, overflowY: 'auto' }}>
                {d.bookings.slice(0, 3).map((b) => (
                  <button
                    key={b.id}
                    onClick={() => handleBookingClick(b)}
                    disabled={!b.conversation_id}
                    title={`${b.customer_name} · ${b.booking_time ? fmtTime(b.booking_time) : 'time TBD'}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4, textAlign: 'left',
                      background: 'rgba(255,255,255,0.04)', borderRadius: '3px 5px 5px 3px', padding: '3px 6px',
                      borderLeft: `2px solid ${STATUS_COLOR[b.status] ?? LABEL_COLOR}`, cursor: b.conversation_id ? 'pointer' : 'default',
                    }}
                  >
                    <span style={{ fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{b.customer_name}</span>
                    {b.payment_confirmed && <PaidBadge />}
                    {b.has_open_escalation && <EscalationDot />}
                  </button>
                ))}
                {d.bookings.length > 3 && (
                  <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.35)', padding: '2px 6px' }}>+{d.bookings.length - 3} more</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
