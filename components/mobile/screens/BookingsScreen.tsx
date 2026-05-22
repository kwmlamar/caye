'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import {
  getBookings,
  getWeekCounts,
  weekAround,
  todayISO,
  channelName,
  type MobileBooking,
  type WeekDay,
} from '@/lib/data/mobile'
import MIcon from '../MIcon'
import ChannelPip from '../ChannelPip'

export default function BookingsScreen() {
  const { workspace } = useWorkspace()

  // weekAnchor drives which Sun–Sat week the strip shows; always real dates.
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => new Date())
  const [selectedISO, setSelectedISO] = useState<string>(() => todayISO())
  const [counts, setCounts] = useState<Record<string, { count: number; caye: number }>>({})
  const [bookings, setBookings] = useState<MobileBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const week: WeekDay[] = useMemo(() => weekAround(weekAnchor), [weekAnchor])

  const monthLabel = useMemo(
    () =>
      new Date(week[3].iso + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      }),
    [week]
  )

  // Load week counts whenever the visible week changes.
  useEffect(() => {
    let active = true
    getWeekCounts(workspace.id, week).then(c => active && setCounts(c))
    return () => {
      active = false
    }
  }, [workspace.id, week])

  const loadDay = useCallback(
    (iso: string) => {
      setLoading(true)
      setExpandedId(null)
      getBookings(workspace.id, iso)
        .then(setBookings)
        .finally(() => setLoading(false))
    },
    [workspace.id]
  )

  useEffect(() => {
    loadDay(selectedISO)
  }, [selectedISO, loadDay])

  const shiftWeek = (days: number) => {
    const next = new Date(weekAnchor)
    next.setDate(next.getDate() + days)
    setWeekAnchor(next)
  }
  const goToday = () => {
    setWeekAnchor(new Date())
    setSelectedISO(todayISO())
  }

  const guests = bookings.reduce((sum, b) => sum + b.people, 0)
  const selectedDay = week.find(d => d.iso === selectedISO)
  const headingDate = new Date(selectedISO + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })

  return (
    <div className="m-screen" data-screen-label="Bookings">
      <div className="m-screen-head" style={{ paddingBottom: 10 }}>
        <div className="eyebrow">
          <span className="caye-pip" />
          Your day
        </div>
        <h1>Today on the dock</h1>
      </div>

      <div className="date-strip">
        <div className="date-strip-head">
          <div className="month">{monthLabel}</div>
          <div className="nav">
            <button onClick={() => shiftWeek(-7)} aria-label="Previous week">
              <MIcon name="chevL" size={14} />
            </button>
            <button className="today" onClick={goToday}>
              Today
            </button>
            <button onClick={() => shiftWeek(7)} aria-label="Next week">
              <MIcon name="chevR" size={14} />
            </button>
          </div>
        </div>
        <div className="day-row">
          {week.map(d => {
            const c = counts[d.iso]?.count ?? 0
            const caye = counts[d.iso]?.caye ?? 0
            return (
              <div
                key={d.iso}
                className={
                  'day-pill' +
                  (d.iso === selectedISO ? ' today' : '') +
                  (c === 0 ? ' empty' : '')
                }
                onClick={() => setSelectedISO(d.iso)}
                style={{ cursor: 'pointer' }}
              >
                <span className="dow">{d.dow}</span>
                <span className="dnum">{d.num}</span>
                <span className="dcnt">{c}</span>
                {c > 0 && (
                  <span className="pip-row">
                    {Array.from({ length: Math.min(c, 4) }).map((_, i) => (
                      <span key={i} className={i < caye ? 'caye' : ''} />
                    ))}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="m-section-label" style={{ marginTop: 4 }}>
        <span>
          {selectedDay?.isToday ? 'Today' : headingDate} · {bookings.length} tour
          {bookings.length === 1 ? '' : 's'} · {guests} guest{guests === 1 ? '' : 's'}
        </span>
      </div>

      <div className="bkg-list">
        {loading ? (
          <div className="bkg-card">
            <div className="bkg-top">
              <div className="bkg-body">
                <div className="bkg-tour">Loading…</div>
              </div>
            </div>
          </div>
        ) : bookings.length === 0 ? (
          <div className="held-calm" style={{ marginTop: 8 }}>
            <div className="ico">
              <MIcon name="cal" size={26} />
            </div>
            <h2>No tours scheduled</h2>
            <p>Nothing on the books for this day yet.</p>
          </div>
        ) : (
          bookings.map(b => {
            const expanded = expandedId === b.id
            return (
              <div
                key={b.id}
                className={'bkg-card' + (b.byCaye ? ' by-caye' : '') + (expanded ? ' expanded' : '')}
              >
                <div
                  className="bkg-top"
                  onClick={() => setExpandedId(expanded ? null : b.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="bkg-time">
                    <div className="t">{b.time}</div>
                    <div className="ap">{b.ampm}</div>
                    <div className="dur">{b.durLabel}</div>
                  </div>
                  <div className="bkg-body">
                    <div className="bkg-tour">{b.tour}</div>
                    <div className="bkg-who">
                      {b.guest}
                      <span className="dot">·</span>
                      <span>
                        {b.people} {b.people === 1 ? 'guest' : 'guests'}
                      </span>
                    </div>
                    <div className="bkg-tags">
                      <span className="tag-pill">
                        <ChannelPip ch={b.channel} size="sm" />
                        {channelName(b.channel)}
                      </span>
                      {b.byCaye && (
                        <span className="caye-tag">
                          <span className="dot" />
                          Booked by Caye
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ alignSelf: 'center', color: 'var(--m-ink-faint)', marginLeft: 4 }}>
                    <MIcon name={expanded ? 'chevD' : 'chev'} size={16} />
                  </div>
                </div>

                {expanded && (
                  <div className="bkg-expand">
                    <div className="bkg-fields">
                      <div className="bkg-field">
                        <div className="k">Full name</div>
                        <div className="v">{b.guest}</div>
                      </div>
                      <div className="bkg-field">
                        <div className="k">Guests</div>
                        <div className="v">{b.people}</div>
                      </div>
                      <div className="bkg-field full">
                        <div className="k">Tour date</div>
                        <div className="v">{b.dateLabel}</div>
                      </div>
                      {b.phone && (
                        <div className="bkg-field">
                          <div className="k">Phone</div>
                          <div
                            className="v"
                            style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 12.5 }}
                          >
                            {b.phone}
                          </div>
                        </div>
                      )}
                      <div className="bkg-field">
                        <div className="k">Status</div>
                        <div className={'v ' + (b.status === 'confirmed' ? 'lunch-y' : 'lunch-n')}>
                          {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                        </div>
                      </div>
                      {b.email && (
                        <div className="bkg-field full">
                          <div className="k">Email</div>
                          <div className="v">{b.email}</div>
                        </div>
                      )}
                      {b.notes && (
                        <div className="bkg-field full">
                          <div className="k">Notes</div>
                          <div className="v">{b.notes}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div style={{ height: 16 }} />
    </div>
  )
}
