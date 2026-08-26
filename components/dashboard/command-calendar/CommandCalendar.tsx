'use client'

import { useState, useEffect, type ReactNode } from 'react'
import type { Booking } from '@/lib/useCommandOverview'
import { useCommandMonthBookings } from '@/lib/useCommandMonthBookings'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'

const LABEL_COLOR = '#71717a'

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

// Booking status → the accent color a detail row's left edge renders
// with. Month-grid cells no longer carry per-status color (see
// MonthDayCell) — a cell just says "something's here," the agenda below
// it says what.
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

// monthDate is a UTC-midnight Date built from getUTCFullYear/getUTCMonth,
// so this must render in UTC too or it can show the wrong month near a
// local-timezone midnight boundary.
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

interface MonthCell {
  iso: string
  dayNum: number
  inMonth: boolean
  isToday: boolean
  bookings: Booking[]
}

// A cell says "something's here" and "this needs you," not a legend of
// every status color at once — a 28px square can't carry that much
// meaning legibly, and the day's own agenda strip below already breaks
// it down properly once you click in.
function MonthDayCell({ cell, selected, onSelect }: { cell: MonthCell; selected: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false)
  const hasEscalation = cell.bookings.some((b) => b.has_open_escalation)
  const hasBookings = cell.bookings.length > 0
  const interactive = cell.inMonth

  return (
    <button
      onClick={interactive ? onSelect : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={!interactive}
      style={{
        position: 'relative', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4,
        border: selected ? '1px solid rgba(78,190,206,0.5)' : 'none',
        borderRadius: 8, padding: '6px 6px 5px',
        cursor: interactive ? 'pointer' : 'default',
        background: selected
          ? 'rgba(78,190,206,0.14)'
          : hover && interactive
          ? 'rgba(255,255,255,0.05)'
          : 'transparent',
        opacity: cell.inMonth ? 1 : 0.3,
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
      {hasBookings && (
        <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: '#4EBECE' }} />
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
  onSelectConversation?: (conversationId: string) => void
}

/**
 * A month grid you glance at and a day you click into — that's the whole
 * job. This used to also carry a Week view (a second layout maintained in
 * parallel), per-status-colored dot clusters in every cell, and a
 * "SOURCE CALENDAR · Synced" header nobody needed to see daily. Cut all
 * of it (2026-08-25): Month + a day's own agenda already tells you
 * everything Week did, just without a mode to pick first.
 */
export default function CommandCalendar({ workspaceId, onSelectConversation }: Props) {
  const todayIso = new Date().toISOString().slice(0, 10)

  function handleBookingClick(b: Booking) {
    if (b.conversation_id && onSelectConversation) onSelectConversation(b.conversation_id)
  }

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {monthLabel}{monthOffset === 0 && <span style={{ color: '#4EBECE' }}> · this month</span>}
          </span>
          {monthLoading && !monthData && <CayeLoadingPulse size={11} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <NavButton title="Previous month" onClick={() => setMonthOffset((o) => o - 1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </NavButton>
          {monthOffset !== 0 && (
            <button
              onClick={() => setMonthOffset(0)}
              style={{
                height: 24, padding: '0 10px', fontSize: 11, fontWeight: 500,
                borderRadius: 6, background: 'rgba(255,255,255,0.06)', color: '#a1a1aa', cursor: 'pointer',
              }}
            >
              This month
            </button>
          )}
          <NavButton title="Next month" onClick={() => setMonthOffset((o) => o + 1)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </NavButton>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, flexShrink: 0 }}>
        {DAY_LABELS.map((label) => (
          <div key={label} style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: LABEL_COLOR, letterSpacing: '0.06em', textAlign: 'center', padding: '0 0 2px' }}>
            {label}
          </div>
        ))}
      </div>
      {/* Content-sized, not flex-stretched: a grid row's minimum is its own
          content (day number + a dot), which can't shrink below ~28px.
          flexShrink: 0 here plus overflowY: 'auto' on the outer container
          means a short card just scrolls instead of the row box
          overflowing past its own bounds. */}
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
          <div style={{ fontSize: 11, color: LABEL_COLOR }}>
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
    </div>
  )
}
