'use client'

import { useState, useEffect } from 'react'
import { useLiveEvents } from '@/lib/useLiveEvents'
import { splitLabel, relTime, TONE_COLOR } from './event-visuals'
import { glass, rowDivider, TEXT_QUIET, TEXT } from './surface'

// "Observing an employee working" — the last handful of real things Caye
// has touched, off the same workspace_events stream as CayeLog, just
// shallower. Not a task board: no status columns, nothing to drag. 2026-08-13:
// dropped the boxed icon-per-row treatment for a plain tone dot — this
// reads as a quiet list now, not a stack of mini-cards.
export default function LiveActivity({ workspaceId }: { workspaceId: string }) {
  const { events, loading } = useLiveEvents(workspaceId, 4)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div style={{ ...glass(0.018), borderRadius: 18, padding: '18px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 2px 12px' }}>
        <span aria-hidden style={{
          width: 5, height: 5, borderRadius: '50%',
          background: events.length > 0 ? '#34d399' : TEXT_QUIET,
          boxShadow: events.length > 0 ? '0 0 6px rgba(52,211,153,0.5)' : 'none',
        }} />
        <span style={{
          fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em', textTransform: 'uppercase', color: TEXT_QUIET,
        }}>
          Working now
        </span>
      </div>

      {!loading && events.length === 0 && (
        <p style={{ fontSize: 12.5, color: TEXT_QUIET, padding: '4px 2px 2px' }}>Quiet — nothing in motion right now.</p>
      )}

      {events.map((e, i) => {
        const { title, subtitle } = splitLabel(e.label)
        return (
          <div
            key={e.id}
            className="caye-activity-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '11px 6px',
              margin: '0 -6px', borderRadius: 10,
              borderTop: i === 0 ? 'none' : rowDivider,
              animation: 'caye-view-in 0.2s ease-out',
            }}
          >
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: TONE_COLOR[e.tone], flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {title}
              </div>
              {subtitle && (
                <div style={{ fontSize: 12, color: TEXT_QUIET, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {subtitle}
                </div>
              )}
            </div>
            <span style={{ fontSize: 11, color: TEXT_QUIET, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{relTime(e.at, now)}</span>
          </div>
        )
      })}
    </div>
  )
}
