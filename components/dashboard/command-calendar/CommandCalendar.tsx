'use client'

import { useState, useEffect, type ReactNode } from 'react'
import type { Booking } from '@/lib/useCommandOverview'
import { useCommandMonthBookings } from '@/lib/useCommandMonthBookings'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'

// Same dark-console tokens as FounderHome.tsx — kept local rather than
// imported since FounderHome doesn't export them (matches the pattern
// already used by GlobalPerformance.tsx / ContactsPanel.tsx).
const LABEL_COLOR = '#71717a'
const GRADIENT = 'linear-gradient(90deg, #0766A3, #4EBECE, #FFE4AF)'

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

// Which view opens by default — month gives the founder the whole
// booking rhythm at a glance; week is the drill-down for "what's coming
// up day by day." Remembered per-browser so a switch to week sticks.
const CALENDAR_VIEW_KEY = 'cayeCalendarView'

// Booking status → the accent color it renders with. Nothing distinguished
// these before this pass — every booking looked identical regardless of
// whether the customer had actually confirmed.
const STATUS_COLOR: Record<string, string> = {
  confirmed: '#4EBECE',
  pending: '#FFE4AF',
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

// Same UTC-pin as fmtMonthYear below — monday/sunday are UTC-midnight
// Date objects, so this must render in UTC too or it can show the wrong
// day near a local-timezone midnight boundary.
function fmtDayMonth(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// timeZone: 'UTC' matters here — monthDate is a UTC-midnight Date built
// from getUTCFullYear/getUTCMonth (matching every other date computed in
// this file), and toLocaleDateString defaults to the browser's local
// timezone. Without pinning it, a US-timezone browser renders the 1st of
// the month as if it were still the last day of the month before —
// disagreeing with the grid's own (correctly UTC) day numbers.
function fmtMonthYear(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function fmtFullDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
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
        borderRadius: 6, background: 'rgba(255,255,255,0.06)',
        color: disabled ? '#3f3f46' : '#a1a1aa', cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {children}
    </button>
  )
}

function ViewToggle({ view, onChange }: { view: 'month' | 'week'; onChange: (v: 'month' | 'week') => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 3, flexShrink: 0 }}>
      {(['month', 'week'] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            border: 'none', cursor: 'pointer', padding: '4px 11px', borderRadius: 6,
            fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em',
            background: view === v ? '#f5f5f4' : 'transparent',
            color: view === v ? '#0a0a0b' : '#a1a1aa',
            transition: 'background 0.15s ease, color 0.15s ease',
          }}
        >
          {v}
        </button>
      ))}
    </div>
  )
}

interface MonthCell {
  iso: string
  dayNum: number
  inMonth: boolean
  isToday: boolean
  bookings: Booking[]
}

const MAX_CELL_DOTS = 5

function MonthDayCell({ cell, selected, onSelect }: { cell: MonthCell; selected: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false)
  const hasEscalation = cell.bookings.some((b) => b.has_open_escalation)
  const interactive = cell.inMonth

  return (
    <button
      onClick={interactive ? onSelect : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={!interactive}
      style={{
        position: 'relative', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4,
        border: selected ? '1px solid rgba(78,190,206,0.5)' : cell.isToday ? '1px solid rgba(78,190,206,0.25)' : '1px solid transparent',
        borderRadius: 8, padding: '6px 6px 5px',
        cursor: interactive ? 'pointer' : 'default',
        background: selected
          ? 'rgba(78,190,206,0.14)'
          : hover && interactive
          ? 'rgba(255,255,255,0.07)'
          : cell.isToday
          ? 'rgba(78,190,206,0.06)'
          : 'rgba(255,255,255,0.02)',
        opacity: cell.inMonth ? 1 : 0.35,
        transition: 'background 0.12s ease, border-color 0.12s ease',
        minHeight: 0,
      }}
    >
      {hasEscalation && (
        <span aria-hidden style={{ position: 'absolute', top: 5, right: 5, width: 5, height: 5, borderRadius: '50%', background: '#fb7185', boxShadow: '0 0 0 2px rgba(251,113,133,0.25)' }} />
      )}
      <span style={{
        fontSize: 11, fontFamily: 'var(--font-display)', fontWeight: cell.isToday ? 700 : 600,
        color: cell.isToday ? '#4EBECE' : cell.inMonth ? '#f4f4f5' : '#71717a',
      }}>
        {cell.dayNum}
      </span>
      {cell.bookings.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
          {cell.bookings.slice(0, MAX_CELL_DOTS).map((b) => (
            <span key={b.id} style={{ width: 5, height: 5, borderRadius: '50%', background: STATUS_COLOR[b.status] ?? LABEL_COLOR, flexShrink: 0 }} />
          ))}
          {cell.bookings.length > MAX_CELL_DOTS && (
            <span style={{ fontSize: 8, color: 'rgba(245,245,244,0.4)', fontFamily: 'var(--font-mono)' }}>+{cell.bookings.length - MAX_CELL_DOTS}</span>
          )}
        </div>
      )}
    </button>
  )
}

function BookingDetailRow({ b, onClick }: { b: Booking; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={!b.conversation_id}
      style={{
        textAlign: 'left', background: 'rgba(255,255,255,0.06)',
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
  )
}

interface Props {
  workspaceId: string
  bookings: Booking[]
  weekStart: string // YYYY-MM-DD, Monday
  weekOffset: number
  onWeekOffsetChange: (offset: number) => void
  onSelectConversation?: (conversationId: string) => void
}

export default function CommandCalendar({ workspaceId, bookings, weekStart, weekOffset, onWeekOffsetChange, onSelectConversation }: Props) {
  const todayIso = new Date().toISOString().slice(0, 10)

  const [view, setView] = useState<'month' | 'week'>(() => {
    if (typeof window === 'undefined') return 'month'
    return window.localStorage.getItem(CALENDAR_VIEW_KEY) === 'week' ? 'week' : 'month'
  })
  useEffect(() => {
    window.localStorage.setItem(CALENDAR_VIEW_KEY, view)
  }, [view])

  function handleBookingClick(b: Booking) {
    if (b.conversation_id && onSelectConversation) onSelectConversation(b.conversation_id)
  }

  // ── Week view (unchanged) ──
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

  // ── Month view ──
  const [monthOffset, setMonthOffset] = useState(0)
  const [selectedDayIso, setSelectedDayIso] = useState<string | null>(todayIso)
  // A month change invalidates whatever was selected in the old one —
  // default back to today when that's actually in view, otherwise leave
  // the agenda strip empty until the founder picks a day.
  useEffect(() => {
    setSelectedDayIso(monthOffset === 0 ? todayIso : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthOffset])

  const { data: monthData, loading: monthLoading } = useCommandMonthBookings(workspaceId, monthOffset)

  const now = new Date()
  const monthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1))
  const monthLabel = fmtMonthYear(monthDate)
  const daysInMonth = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate()
  const firstDow = monthDate.getUTCDay() // 0 = Sunday
  const leadingBlanks = firstDow === 0 ? 6 : firstDow - 1 // cells before day 1, Monday-first grid
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7

  const monthBookingsByDate = new Map<string, Booking[]>()
  for (const b of monthData?.bookings ?? []) {
    const arr = monthBookingsByDate.get(b.booking_date) ?? []
    arr.push(b)
    monthBookingsByDate.set(b.booking_date, arr)
  }

  const monthCells: MonthCell[] = Array.from({ length: totalCells }, (_, i) => {
    const cellDate = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1 - leadingBlanks + i))
    const iso = cellDate.toISOString().slice(0, 10)
    return {
      iso,
      dayNum: cellDate.getUTCDate(),
      inMonth: cellDate.getUTCMonth() === monthDate.getUTCMonth(),
      isToday: iso === todayIso,
      bookings: monthBookingsByDate.get(iso) ?? [],
    }
  })

  const selectedDayBookings = selectedDayIso ? (monthBookingsByDate.get(selectedDayIso) ?? []) : []

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20, color: '#f5f5f4', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingRight: 36, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.06em', color: LABEL_COLOR }}>SOURCE CALENDAR</span>
            <Pill color="#4EBECE" label="Synced" dot={false} />
            {view === 'month' && monthLoading && !monthData && <CayeLoadingPulse size={11} />}
          </div>
          <p style={{ fontSize: 12, color: 'rgba(245,245,244,0.4)', marginTop: 4 }}>
            {view === 'month' ? (
              <>{monthLabel}{monthOffset === 0 && <span style={{ color: '#4EBECE' }}> · this month</span>}</>
            ) : (
              <>{fmtDayMonth(monday)} – {fmtDayMonth(sunday)}{weekOffset === 0 && <span style={{ color: '#4EBECE' }}> · this week</span>}</>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <ViewToggle view={view} onChange={setView} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {view === 'month' ? (
              <>
                <NavButton title="Previous month" onClick={() => setMonthOffset((o) => o - 1)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </NavButton>
                {monthOffset !== 0 && (
                  <button
                    onClick={() => setMonthOffset(0)}
                    style={{
                      height: 24, padding: '0 10px', fontSize: 10.5, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em',
                      borderRadius: 6, background: 'rgba(255,255,255,0.06)', color: '#a1a1aa', cursor: 'pointer',
                    }}
                  >
                    This month
                  </button>
                )}
                <NavButton title="Next month" onClick={() => setMonthOffset((o) => o + 1)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                </NavButton>
              </>
            ) : (
              <>
                <NavButton title="Previous week" onClick={() => onWeekOffsetChange(weekOffset - 1)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                </NavButton>
                {weekOffset !== 0 && (
                  <button
                    onClick={() => onWeekOffsetChange(0)}
                    style={{
                      height: 24, padding: '0 10px', fontSize: 10.5, fontWeight: 600, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em',
                      borderRadius: 6, background: 'rgba(255,255,255,0.06)', color: '#a1a1aa', cursor: 'pointer',
                    }}
                  >
                    Today
                  </button>
                )}
                <NavButton title="Next week" onClick={() => onWeekOffsetChange(weekOffset + 1)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                </NavButton>
              </>
            )}
          </div>
        </div>
      </div>

      {view === 'month' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, flexShrink: 0 }}>
            {DAY_LABELS.map((label) => (
              <div key={label} style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: LABEL_COLOR, letterSpacing: '0.06em', textAlign: 'center', padding: '0 0 2px' }}>
                {label}
              </div>
            ))}
          </div>
          {/* Content-sized, not flex-stretched: a grid row's minimum is its
              own content (day number + dot row), which can't shrink below
              ~28px. Forcing it to fill a shorter flex remainder (the old
              `flex: 1, minHeight: 0` + gridAutoRows: '1fr') made rows
              collapse past that minimum, which doesn't clip — it overflows
              the row box and bleeds into whatever renders next, which is
              exactly the "text on top of grid" corruption this replaces.
              flexShrink: 0 here plus overflowY: 'auto' on the outer
              container (above) means a short card just scrolls instead. ── */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: 'minmax(28px, auto)',
            gap: 4, flexShrink: 0,
          }}>
            {monthCells.map((cell) => (
              <MonthDayCell
                key={cell.iso}
                cell={cell}
                selected={cell.iso === selectedDayIso}
                onSelect={() => setSelectedDayIso(cell.iso === selectedDayIso ? null : cell.iso)}
              />
            ))}
          </div>

          {selectedDayIso && (
            <div style={{
              flexShrink: 0, maxHeight: 200, overflowY: 'auto',
              borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10,
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: LABEL_COLOR, letterSpacing: '0.06em' }}>
                {fmtFullDate(selectedDayIso)}{selectedDayIso === todayIso && <span style={{ color: '#4EBECE' }}> · Today</span>}
              </div>
              {selectedDayBookings.length === 0 ? (
                <div style={{ fontSize: 11, color: 'rgba(245,245,244,0.3)' }}>No bookings.</div>
              ) : (
                selectedDayBookings.map((b) => (
                  <BookingDetailRow key={b.id} b={b} onClick={() => handleBookingClick(b)} />
                ))
              )}
            </div>
          )}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: week.map((d) => (d.isToday ? '1.7fr' : '1fr')).join(' '), gap: 6, flex: 1, minHeight: 0 }}>
          {week.map((d) => (
            <div key={d.label} style={{
              position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column',
              background: d.isToday ? 'rgba(78,190,206,0.07)' : 'rgba(255,255,255,0.045)',
              border: d.isToday ? '1px solid rgba(78,190,206,0.4)' : 'none',
              borderRadius: 10, padding: d.isToday ? 10 : 8,
            }}>
              {d.isToday && <div aria-hidden style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: GRADIENT }} />}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: d.isToday ? '#4EBECE' : '#71717a', letterSpacing: '0.06em' }}>{d.label}</span>
                <span style={{ fontSize: d.isToday ? 15 : 13, fontFamily: 'var(--font-display)', fontWeight: 600 }}>{d.date}</span>
                {d.isToday && <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: '#4EBECE', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Today</span>}
              </div>

              {d.bookings.length === 0 ? (
                <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.25)' }}>no bookings</div>
              ) : d.isToday ? (
                // Today gets the full detail: time, customer, tour, guests,
                // status/payment/escalation — the "what needs handling right
                // now" surface the founder actually checks.
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
                  {d.bookings.map((b) => (
                    <BookingDetailRow key={b.id} b={b} onClick={() => handleBookingClick(b)} />
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
      )}
    </div>
  )
}
