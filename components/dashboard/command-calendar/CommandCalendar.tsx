'use client'

import { useState } from 'react'

const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'

// Mock data shaped like the eventual real query (bookings table, joined
// to the workspace's connected calendar source) so wiring real data in
// later is a data-swap, not a redesign. Frontend-first per 2026-07-02 —
// no Supabase calls in this file yet.
interface MockBooking {
  time: string
  tour: string
  price: string
}
const MOCK_WEEK: { day: string; date: number; bookings: MockBooking[] }[] = [
  { day: 'MON', date: 29, bookings: [{ time: '9:00', tour: 'Sit-Low', price: '$175' }] },
  { day: 'TUE', date: 30, bookings: [{ time: '14:00', tour: 'Heritage', price: '$220' }] },
  { day: 'WED', date: 1, bookings: [] },
  { day: 'THU', date: 2, bookings: [{ time: '9:00', tour: 'Sit-Low', price: '$350' }] },
  { day: 'FRI', date: 3, bookings: [{ time: '8:00', tour: 'Private', price: '$1200' }] },
  { day: 'SAT', date: 4, bookings: [{ time: '10:00', tour: 'Golf Cart', price: '$440' }] },
  { day: 'SUN', date: 5, bookings: [] },
]

export default function CommandCalendar() {
  const [view, setView] = useState<'calendar' | 'list'>('calendar')
  const [range, setRange] = useState<'week' | 'month'>('week')

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20, color: '#f5f5f4' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(245,245,244,0.5)' }}>SOURCE CALENDAR</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#7DC9CB', border: '1px solid rgba(125,201,203,0.4)', borderRadius: 999, padding: '2px 8px' }}>
              SYNCED
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'rgba(245,245,244,0.4)', marginTop: 4, maxWidth: 340 }}>
            Reads live from the workspace&apos;s connected calendar — Caye books here, this view just reflects it.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.06)', borderRadius: 999, padding: 3 }}>
            {(['calendar', 'list'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
                  fontSize: 11, fontWeight: 600, textTransform: 'capitalize',
                  background: view === v ? '#f5f5f4' : 'transparent',
                  color: view === v ? '#0a0a0b' : 'rgba(245,245,244,0.5)',
                }}
              >
                {v}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.06)', borderRadius: 999, padding: 3 }}>
            {(['week', 'month'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
                  fontSize: 11, fontWeight: 600, textTransform: 'capitalize',
                  background: range === r ? '#f5f5f4' : 'transparent',
                  color: range === r ? '#0a0a0b' : 'rgba(245,245,244,0.5)',
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {view === 'calendar' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
          {MOCK_WEEK.map((d) => (
            <div key={d.day} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: 8, minHeight: 96 }}>
              <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.35)', letterSpacing: '0.06em' }}>{d.day}</div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{d.date}</div>
              {d.bookings.length === 0 ? (
                <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.25)' }}>no bookings</div>
              ) : (
                d.bookings.map((b, i) => (
                  <div key={i} style={{ borderLeft: '2px solid transparent', borderImage: `${GRADIENT} 1`, background: 'rgba(255,255,255,0.05)', borderRadius: 5, padding: '4px 6px', marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.5)' }}>{b.time}</div>
                    <div style={{ fontSize: 10, fontWeight: 600 }}>{b.tour}</div>
                    <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.4)' }}>{b.price}</div>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {MOCK_WEEK.flatMap((d) => d.bookings.map((b, i) => ({ ...b, day: d.day, date: d.date, key: `${d.day}-${i}` })))
            .map((b) => (
              <div key={b.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 14px' }}>
                <div>
                  <span style={{ fontSize: 11, color: 'rgba(245,245,244,0.4)', marginRight: 10 }}>{b.day} {b.date} · {b.time}</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{b.tour}</span>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{b.price}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
