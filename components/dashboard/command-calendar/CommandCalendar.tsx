'use client'

import { useState } from 'react'
import type { Booking } from '@/lib/useCommandOverview'

const GRADIENT = 'linear-gradient(90deg, #00778B, #7DC9CB, #FFD68F)'
const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

interface Props {
  bookings: Booking[]
  weekStart: string // YYYY-MM-DD, Monday
}

function fmtTime(t: string): string {
  const [h, m] = t.split(':')
  return `${h}:${m}`
}

export default function CommandCalendar({ bookings, weekStart }: Props) {
  const [view, setView] = useState<'calendar' | 'list'>('calendar')
  const [range, setRange] = useState<'week' | 'month'>('week')

  const parsed = new Date(`${weekStart}T00:00:00Z`)
  const monday = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  const week = DAY_LABELS.map((label, i) => {
    const d = new Date(monday)
    d.setUTCDate(monday.getUTCDate() + i)
    const iso = d.toISOString().slice(0, 10)
    return {
      label,
      date: d.getUTCDate(),
      bookings: bookings.filter((b) => b.booking_date === iso),
    }
  })

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20, color: '#f5f5f4' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.06em', color: '#71717a' }}>SOURCE CALENDAR</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#7DC9CB', background: 'rgba(125,201,203,0.1)', border: '1px solid rgba(125,201,203,0.3)', borderRadius: 999, padding: '2px 8px' }}>
              SYNCED
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'rgba(245,245,244,0.4)', marginTop: 4, maxWidth: 340 }}>
            Reads live from the bookings table — Caye books here, this view just reflects it.
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
                title={r === 'month' ? 'Month view — coming soon' : undefined}
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
          {week.map((d) => (
            <div key={d.label} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: 8, minHeight: 96 }}>
              <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: '#71717a', letterSpacing: '0.06em' }}>{d.label}</div>
              <div style={{ fontSize: 13, fontFamily: 'var(--font-display)', fontWeight: 600, marginBottom: 6 }}>{d.date}</div>
              {d.bookings.length === 0 ? (
                <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.25)' }}>no bookings</div>
              ) : (
                d.bookings.map((b) => (
                  <div key={b.id} title={b.customer_name} style={{ borderLeft: '2px solid transparent', borderImage: `${GRADIENT} 1`, background: 'rgba(255,255,255,0.05)', borderRadius: 5, padding: '4px 6px', marginBottom: 4 }}>
                    <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.5)' }}>{fmtTime(b.booking_time)}</div>
                    <div style={{ fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.customer_name}</div>
                    <div style={{ fontSize: 9, color: 'rgba(245,245,244,0.4)' }}>{b.number_of_people} guest{b.number_of_people === 1 ? '' : 's'}</div>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {bookings.length === 0 ? (
            <div style={{ fontSize: 13, color: 'rgba(245,245,244,0.35)' }}>No bookings this week.</div>
          ) : (
            bookings.map((b) => (
              <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 14px' }}>
                <div>
                  <span style={{ fontSize: 11, color: 'rgba(245,245,244,0.4)', marginRight: 10 }}>{b.booking_date} · {fmtTime(b.booking_time)}</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{b.customer_name}</span>
                </div>
                <span style={{ fontSize: 12, color: 'rgba(245,245,244,0.5)' }}>{b.number_of_people} guest{b.number_of_people === 1 ? '' : 's'}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
