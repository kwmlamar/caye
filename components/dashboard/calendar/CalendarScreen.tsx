import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { getSupabase } from '@/lib/supabase'
import { useWorkspace } from '@/lib/workspace-context'
import BookingModal, { type BookingModalData } from './BookingModal'
import { useDashboard } from '@/lib/dashboard-context'
import { CaretLeft, CaretRight, Plus } from '@phosphor-icons/react'

const ROW_H = 56
const START = 8
const HOURS = Array.from({ length: 11 }, (_, i) => i + 8) // 8 am – 6 pm
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface SupaBooking {
  id: string
  customer_name: string
  customer_phone: string | null
  customer_email: string | null
  service_id: string | null
  booking_date: string        // 'YYYY-MM-DD'
  booking_time: string        // 'HH:MM:SS'
  number_of_people: number
  duration_minutes: number | null
  status: 'confirmed' | 'pending' | 'completed' | 'cancelled'
  notes: string | null
  conversation_id: string | null
  service: { name: string; duration_minutes: number; is_shared: boolean; max_capacity: number }[] | null
}

/** A slot is either one booking or a merged group of parties sharing the same time. */
type CalendarSlot =
  | { kind: 'single'; booking: SupaBooking }
  | {
      kind: 'group'
      serviceId: string
      serviceName: string
      time: string
      durationMinutes: number
      maxCapacity: number
      totalGuests: number
      bookings: SupaBooking[]
    }

function mergeSharedBookings(bks: SupaBooking[]): CalendarSlot[] {
  // Group by (service_id, booking_time) when service.is_shared. Anything
  // without a shared service stays as its own single slot.
  type Key = string
  const groupKey = (b: SupaBooking): Key | null => {
    const svc = b.service?.[0]
    if (!svc?.is_shared || !b.service_id) return null
    return `${b.service_id}|${b.booking_time}`
  }
  const groups = new Map<Key, SupaBooking[]>()
  const singles: SupaBooking[] = []
  for (const b of bks) {
    const k = groupKey(b)
    if (!k) { singles.push(b); continue }
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(b)
  }
  const slots: CalendarSlot[] = singles.map(b => ({ kind: 'single', booking: b }))
  for (const list of groups.values()) {
    if (list.length === 1) {
      slots.push({ kind: 'single', booking: list[0] })
      continue
    }
    const first = list[0]
    const svc = first.service![0]
    slots.push({
      kind: 'group',
      serviceId: first.service_id!,
      serviceName: svc.name,
      time: first.booking_time,
      durationMinutes: first.duration_minutes ?? svc.duration_minutes ?? 120,
      maxCapacity: svc.max_capacity,
      totalGuests: list.reduce((a, b) => a + b.number_of_people, 0),
      bookings: list,
    })
  }
  // Sort by time for stable rendering
  return slots.sort((a, b) => {
    const ta = a.kind === 'single' ? a.booking.booking_time : a.time
    const tb = b.kind === 'single' ? b.booking.booking_time : b.time
    return ta.localeCompare(tb)
  })
}

function emptyBookingForm(date?: string, time = '10:00'): BookingModalData {
  return {
    service_id: null,
    customer_name: '',
    customer_phone: '',
    customer_email: '',
    booking_date: date ?? new Date().toISOString().slice(0, 10),
    booking_time: time,
    number_of_people: 1,
    duration_minutes: null,
    status: 'confirmed',
    notes: '',
  }
}

function bookingToForm(b: SupaBooking): BookingModalData {
  return {
    id: b.id,
    service_id: b.service_id,
    customer_name: b.customer_name,
    customer_phone: b.customer_phone ?? '',
    customer_email: b.customer_email ?? '',
    booking_date: b.booking_date,
    booking_time: b.booking_time.slice(0, 5),
    number_of_people: b.number_of_people,
    duration_minutes: b.duration_minutes,
    status: b.status,
    notes: b.notes ?? '',
  }
}

/** Effective duration: per-booking override → service → 120 legacy default. */
function effectiveDurationMinutes(b: SupaBooking): number {
  return b.duration_minutes ?? b.service?.[0]?.duration_minutes ?? 120
}

function weekStart(date: Date): Date {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay())
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function t2h(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number)
  return h + m / 60
}

function fmtTime(timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${ampm}`
}

function nowDecimalHours(): number {
  const n = new Date()
  return n.getHours() + n.getMinutes() / 60
}

function timeOfDayGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Morning'
  if (h < 17) return 'Afternoon'
  return 'Evening'
}

function fmtEndTime(startTimeStr: string, durationMins: number): string {
  const [h, m] = startTimeStr.split(':').map(Number)
  const totalMins = h * 60 + m + durationMins
  const eh = Math.floor(totalMins / 60)
  const em = totalMins % 60
  return `${eh % 12 || 12}:${String(em).padStart(2, '0')}${eh >= 12 ? 'pm' : 'am'}`
}

function buildMonthGrid(date: Date): (Date | null)[] {
  const year = date.getFullYear()
  const month = date.getMonth()
  const firstDow = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (Date | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ]
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export default function CalendarScreen({ inPanel = false }: { inPanel?: boolean }) {
  const { workspaceId } = useWorkspace()
  const { isPanelDetail, setIsPanelDetail } = useDashboard()

  const todayDate = new Date()
  todayDate.setHours(0, 0, 0, 0)

  const [view, setView] = useState<'WEEK' | 'DAY' | 'MONTH'>(inPanel ? 'DAY' : 'WEEK')
  const [weekOf, setWeekOf] = useState<Date>(weekStart(todayDate))
  const [monthOf, setMonthOf] = useState<Date>(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1))
  const [bookings, setBookings] = useState<SupaBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState<{ mode: 'new' | 'edit'; data: BookingModalData } | null>(null)

  // Ticks every minute to redraw the "now" marker on the day/week grid.
  const [nowHours, setNowHours] = useState<number>(() => nowDecimalHours())
  useEffect(() => {
    const id = setInterval(() => setNowHours(nowDecimalHours()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Ref the scrollable grid so we can scroll to "now" on mount.
  const gridRef = useRef<HTMLDivElement | null>(null)

  const weekDays = view === 'DAY' ? [todayDate] : Array.from({ length: 7 }, (_, i) => addDays(weekOf, i))
  const weekEnd = weekDays[weekDays.length - 1]

  const fetchBookings = useCallback(async () => {
    setLoading(true)
    const supabase = getSupabase()

    let start: string, end: string
    if (view === 'MONTH') {
      const y = monthOf.getFullYear(), mo = monthOf.getMonth()
      start = toISO(new Date(y, mo, 1))
      end = toISO(new Date(y, mo + 1, 0))
    } else if (view === 'DAY') {
      start = toISO(todayDate)
      end = toISO(todayDate)
    } else {
      start = toISO(weekOf)
      end = toISO(weekEnd)
    }

    const { data, error } = await supabase
      .from('bookings')
      .select('id, customer_name, customer_phone, customer_email, service_id, booking_date, booking_time, number_of_people, duration_minutes, status, notes, conversation_id, service:booking_services(name, duration_minutes, is_shared, max_capacity)')
      .eq('user_id', workspaceId)
      .gte('booking_date', start)
      .lte('booking_date', end)
      .neq('status', 'cancelled')
      .order('booking_date')
      .order('booking_time')

    if (!error) setBookings((data ?? []) as unknown as SupaBooking[])
    setLoading(false)
  }, [view, weekOf, monthOf, workspaceId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchBookings() }, [fetchBookings])

  useEffect(() => {
    if (inPanel && !isPanelDetail) {
      setModal(null)
    }
  }, [isPanelDetail, inPanel])

  const bookingsForDate = (iso: string) => bookings.filter(b => b.booking_date === iso)
  const isToday = (d: Date) => toISO(d) === toISO(todayDate)

  const navPrev = () => {
    if (view === 'MONTH') {
      setMonthOf(m => addMonths(m, -1))
    } else if (view === 'DAY') {
      // In Day view, we can just move todayDate forward/backward. For simplicity:
      todayDate.setDate(todayDate.getDate() - 1)
      fetchBookings()
    } else {
      setWeekOf(w => addDays(w, -7))
    }
  }
  const navNext = () => {
    if (view === 'MONTH') {
      setMonthOf(m => addMonths(m, 1))
    } else if (view === 'DAY') {
      todayDate.setDate(todayDate.getDate() + 1)
      fetchBookings()
    } else {
      setWeekOf(w => addDays(w, 7))
    }
  }
  const goToday = () => {
    setWeekOf(weekStart(todayDate))
    setMonthOf(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1))
  }

  const rangeLabel = view === 'MONTH'
    ? monthOf.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : view === 'DAY'
    ? todayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
    : (() => {
        const f = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-US', o)
        return `${f(weekOf, { month: 'short', day: 'numeric' })} – ${f(weekEnd, { month: 'short', day: 'numeric', year: 'numeric' })}`
      })()

  const confirmed = bookings.filter(b => b.status === 'confirmed').length
  const pending = bookings.filter(b => b.status === 'pending').length
  const byCaye = bookings.filter(b => !!b.conversation_id).length
  const guests = bookings.reduce((a, b) => a + b.number_of_people, 0)

  const monthGrid = view === 'MONTH' ? buildMonthGrid(monthOf) : []

  // Day-context summary for the panel header: next-up booking + scheduled count.
  const todaysBookings = useMemo(
    () => bookingsForDate(toISO(todayDate)).sort((a, b) => a.booking_time.localeCompare(b.booking_time)),
    [bookings] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const nextUpToday = useMemo(() => {
    const nowMin = nowHours * 60
    return todaysBookings.find(b => {
      const [h, m] = b.booking_time.split(':').map(Number)
      return h * 60 + m >= nowMin
    }) ?? null
  }, [todaysBookings, nowHours])

  // On first render of panel day view, scroll the grid to the current time.
  useEffect(() => {
    if (!inPanel || view !== 'DAY' || loading) return
    if (!gridRef.current) return
    const targetTop = Math.max(0, (nowHours - START - 1) * ROW_H)
    gridRef.current.scrollTo({ top: targetTop, behavior: 'auto' })
    // Only on initial mount of the loaded grid; nowHours intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPanel, view, loading])

  if (inPanel && modal && workspaceId) {
    return (
      <BookingModal
        workspaceId={workspaceId}
        initial={modal.data}
        mode={modal.mode}
        inline={true}
        onClose={() => {
          setModal(null)
          setIsPanelDetail(false)
        }}
        onSaved={() => {
          setModal(null)
          setIsPanelDetail(false)
          fetchBookings()
        }}
      />
    )
  }

  return (
    <div className="cal-screen">
      {inPanel ? (
        <header className="cal-head">
          <div className="cal-nav-row">
            <span className="cal-nav-range">{loading ? '…' : rangeLabel}</span>
            <div className="cal-nav-group">
              <button onClick={navPrev} title="Previous">
                <CaretLeft size={12} weight="bold" />
              </button>
              <span className="divider" />
              <button onClick={goToday} style={{ fontSize: '11px', fontWeight: 500 }}>
                Today
              </button>
              <span className="divider" />
              <button onClick={navNext} title="Next">
                <CaretRight size={12} weight="bold" />
              </button>
            </div>
          </div>
          <div className="cal-controls-row">
            <div className="seg-2">
              <span className={view === 'DAY' ? 'on' : ''} onClick={() => setView('DAY')} style={{ cursor: 'pointer' }}>Day</span>
              <span className={view === 'WEEK' ? 'on' : ''} onClick={() => setView('WEEK')} style={{ cursor: 'pointer' }}>Week</span>
              <span className={view === 'MONTH' ? 'on' : ''} onClick={() => setView('MONTH')} style={{ cursor: 'pointer' }}>Month</span>
            </div>
          </div>
        </header>
      ) : (
        <header className="cal-head">
          <div className="cal-left">
            <h2>Calendar</h2>
            <div className="cal-nav">
              <button className="ico-btn" onClick={navPrev}>←</button>
              <span className="cal-range">{loading ? '…' : rangeLabel}</span>
              <button className="ico-btn" onClick={navNext}>→</button>
              <button className="ghost-btn sm" onClick={goToday}>Today</button>
            </div>
          </div>
          <div className="cal-right">
            <div className="cal-stats">
              <span><b>{confirmed}</b> confirmed</span>
              <span><b>{pending}</b> pending</span>
              <span className="caye"><CayeMark size={12} /> <b>{byCaye}</b> by Caye</span>
              <span><b>{guests}</b> guests</span>
            </div>
            <div className="seg-2">
              <span className={view === 'WEEK' ? 'on' : ''} onClick={() => setView('WEEK')} style={{ cursor: 'pointer' }}>Week</span>
              <span className={view === 'DAY' ? 'on' : ''} onClick={() => setView('DAY')} style={{ cursor: 'pointer' }}>Day</span>
              <span className={view === 'MONTH' ? 'on' : ''} onClick={() => setView('MONTH')} style={{ cursor: 'pointer' }}>Month</span>
            </div>
            <button
              className="btn-primary sm cursor-pointer"
              onClick={() => {
                setModal({ mode: 'new', data: emptyBookingForm(toISO(todayDate)) })
              }}
            >
              + New booking
            </button>
          </div>
        </header>
      )}

      {/* ── MONTH VIEW ── */}
      {view === 'MONTH' && (
        <div className="cal-month-wrap">
          <div className="cal-month-dow-row">
            {DOW.map(d => <div key={d} className="cal-month-dow">{d}</div>)}
          </div>
          <div className="cal-month-grid">
            {monthGrid.map((date, i) => {
              if (!date) return <div key={`e${i}`} className="cal-month-cell empty" />
              const iso = toISO(date)
              const dayBks = bookingsForDate(iso)
              return (
                <div key={iso} className={`cal-month-cell${isToday(date) ? ' today' : ''}`}>
                  <span className="cal-month-dnum">{date.getDate()}</span>
                  <div className="cal-month-events">
                    {dayBks.slice(0, 3).map(b => (
                      <div
                        key={b.id}
                        className={`cal-month-bk ${b.status}`}
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          setModal({ mode: 'edit', data: bookingToForm(b) })
                          if (inPanel) {
                            setIsPanelDetail(true)
                          }
                        }}
                      >
                        <span className="cmb-time">{fmtTime(b.booking_time)}</span>
                        <span className="cmb-name">{b.customer_name}</span>
                        <span className="cmb-guests">{b.number_of_people}p</span>
                      </div>
                    ))}
                    {dayBks.length > 3 && (
                      <div className="cal-month-more">+{dayBks.length - 3} more</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── WEEK / DAY VIEW ── */}
      {view !== 'MONTH' && (
        <div className="cal-grid-wrap font-sans" ref={gridRef}>
          {!(inPanel && view === 'DAY') ? (
            <div className="cal-week-head">
              <div className="time-gutter" />
              {weekDays.map(date => {
                const iso = toISO(date)
                const count = bookingsForDate(iso).length
                return (
                  <div key={iso} className={`cal-day-head${isToday(date) ? ' today' : ''}`}>
                    <span className="dow">{DOW[date.getDay()]}</span>
                    <span className="dnum">{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <span className="dcount">{count} tour{count !== 1 ? 's' : ''}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '10px 4px 12px',
                borderBottom: '1px solid rgba(18, 18, 18, 0.06)',
                marginBottom: '6px',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '9.5px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.16em',
                    color: 'rgba(18, 18, 18, 0.4)',
                    fontWeight: 600,
                  }}
                >
                  {timeOfDayGreeting()} · {todayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </div>
                <div style={{ fontSize: '13px', fontWeight: 600, marginTop: '4px', color: 'var(--tc-ink, #121212)' }}>
                  {todaysBookings.length === 0
                    ? 'Nothing scheduled today.'
                    : nextUpToday
                      ? <>Next up · <span style={{ fontFamily: 'var(--font-mono)', color: 'rgba(18,18,18,0.65)' }}>{fmtTime(nextUpToday.booking_time)}</span> · {nextUpToday.customer_name}</>
                      : <>All {todaysBookings.length} tour{todaysBookings.length !== 1 ? 's' : ''} done.</>
                  }
                </div>
              </div>
              <span
                style={{
                  flexShrink: 0,
                  fontFamily: 'var(--font-mono)',
                  fontSize: '9.5px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  background: todaysBookings.length === 0 ? 'rgba(18, 18, 18, 0.04)' : 'rgba(15, 181, 161, 0.12)',
                  color: todaysBookings.length === 0 ? 'rgba(18, 18, 18, 0.4)' : '#1E6157',
                  padding: '3px 9px',
                  borderRadius: '99px',
                  fontWeight: 700,
                  alignSelf: 'flex-start',
                  marginTop: '2px',
                }}
              >
                {todaysBookings.length} {todaysBookings.length === 1 ? 'tour' : 'tours'}
              </span>
            </div>
          )}

          {inPanel && view === 'DAY' && !loading && todaysBookings.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '48px 20px',
                color: 'rgba(18, 18, 18, 0.45)',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '99px',
                  background: 'rgba(18, 18, 18, 0.04)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(18, 18, 18, 0.7)' }}>
                Open schedule today
              </div>
              <div style={{ fontSize: '11px', maxWidth: '220px', lineHeight: 1.5 }}>
                No tours booked. Tap the <strong style={{ color: 'rgba(18,18,18,0.7)' }}>+</strong> below to add one, or wait for Caye to book one for you.
              </div>
            </div>
          ) : (
          <div className="cal-grid">
            <div className="cal-times">
              {HOURS.map(h => (
                <div key={h} className="cal-time-row">
                  <span className="cal-time">{h <= 12 ? h : h - 12}{h < 12 ? 'am' : 'pm'}</span>
                </div>
              ))}
            </div>

            {weekDays.map(date => {
              const iso = toISO(date)
              const slots = mergeSharedBookings(bookingsForDate(iso))
              const showNowLine = isToday(date) && nowHours >= START && nowHours <= START + HOURS.length
              const nowTop = (nowHours - START) * ROW_H
              return (
                <div key={iso} className={`cal-col${isToday(date) ? ' today' : ''}`} style={{ position: 'relative' }}>
                  {HOURS.map(h => <div key={h} className="cal-cell" />)}
                  {showNowLine && (
                    <div
                      aria-hidden
                      style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: nowTop,
                        height: 0,
                        borderTop: '1.5px solid #0FB5A1',
                        zIndex: 5,
                        pointerEvents: 'none',
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          left: '-5px',
                          top: '-5px',
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          background: '#0FB5A1',
                          boxShadow: '0 0 0 3px rgba(15, 181, 161, 0.18)',
                        }}
                      />
                    </div>
                  )}
                  {slots.map(slot => {
                    if (slot.kind === 'single') {
                      const b = slot.booking
                      const durationMins = effectiveDurationMinutes(b)
                      const startH = t2h(b.booking_time)
                      const top = (startH - START) * ROW_H
                      const height = Math.max(38, (durationMins / 60) * ROW_H - 4)
                      const isByCaye = !!b.conversation_id
                      const cls = `bk-card ${b.status}${isByCaye ? ' by-caye' : ''}`
                      return (
                        <div
                          key={b.id}
                          className={cls}
                          style={{ top, height, cursor: 'pointer' }}
                          onClick={() => {
                            setModal({ mode: 'edit', data: bookingToForm(b) })
                            if (inPanel) {
                              setIsPanelDetail(true)
                            }
                          }}
                        >
                          <div className="bk-top">
                            <span className="bk-time">
                              {fmtTime(b.booking_time)}–{fmtEndTime(b.booking_time, durationMins)}
                            </span>
                            {isByCaye && (
                              <span className="bk-caye-tag" title="Booked via Caye">
                                <CayeMark size={12} />
                              </span>
                            )}
                          </div>
                          <div className="bk-tour">{b.service?.[0]?.name ?? 'Island Tour'}</div>
                          <div className="bk-name">{b.customer_name}</div>
                          <div className="bk-foot">
                            <span className="bk-guests">{b.number_of_people} guests</span>
                            <span className={`bk-status ${b.status}`}>
                              {b.status === 'confirmed' ? 'Confirmed' : 'Pending'}
                            </span>
                          </div>
                        </div>
                      )
                    }

                    // Group slot — merged shared-service tour
                    const startH = t2h(slot.time)
                    const top = (startH - START) * ROW_H
                    const height = Math.max(38, (slot.durationMinutes / 60) * ROW_H - 4)
                    const anyByCaye = slot.bookings.some(b => !!b.conversation_id)
                    const cls = `bk-card confirmed group${anyByCaye ? ' by-caye' : ''}`
                    const capacityLabel = `${slot.totalGuests}/${slot.maxCapacity}`
                    const isFull = slot.totalGuests >= slot.maxCapacity
                    return (
                      <div
                        key={`group-${slot.serviceId}-${slot.time}`}
                        className={cls}
                        style={{ top, height }}
                      >
                        <div className="bk-top">
                          <span className="bk-time">
                            {fmtTime(slot.time)}–{fmtEndTime(slot.time, slot.durationMinutes)}
                          </span>
                          {anyByCaye && (
                            <span className="bk-caye-tag" title="Some parties booked via Caye">
                              <CayeMark size={12} />
                            </span>
                          )}
                        </div>
                        <div className="bk-tour">{slot.serviceName}</div>
                        <ul className="bk-parties">
                          {slot.bookings.map(b => (
                            <li
                              key={b.id}
                              className="bk-party"
                              onClick={() => {
                                setModal({ mode: 'edit', data: bookingToForm(b) })
                                if (inPanel) {
                                  setIsPanelDetail(true)
                                }
                              }}
                              style={{ cursor: 'pointer' }}
                            >
                              <span className="bk-party-name">
                                {b.conversation_id && <CayeMark size={10} />}
                                {b.customer_name}
                              </span>
                              <span className="bk-party-guests">{b.number_of_people}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="bk-foot">
                          <span className="bk-guests">
                            {slot.bookings.length} parties · {capacityLabel} guests
                          </span>
                          <span className={`bk-status ${isFull ? 'completed' : 'confirmed'}`}>
                            {isFull ? 'Full' : 'Open'}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
          )}
        </div>
      )}

      {/* Editing Booking Modal Integration (when not in panel) */}
      {!inPanel && modal && workspaceId && (
        <BookingModal
          workspaceId={workspaceId}
          initial={modal.data}
          mode={modal.mode}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); fetchBookings() }}
        />
      )}

      {inPanel && (
        <button
          className="cal-fab"
          title="New booking"
          onClick={() => {
            setModal({ mode: 'new', data: emptyBookingForm(toISO(todayDate)) })
            setIsPanelDetail(true)
          }}
        >
          <Plus size={18} weight="bold" />
        </button>
      )}
    </div>
  )
}
