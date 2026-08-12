'use client'

import { useState, useEffect } from 'react'
import { useLiveEvents } from '@/lib/useLiveEvents'
import { EventIcon, splitLabel, relTime, TONE_COLOR } from './event-visuals'

const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

// "Observing an employee working" — the last handful of real things Caye
// has touched, off the same workspace_events stream as CayeLog, just
// shallower. Not a task board: no status columns, nothing to drag.
export default function LiveActivity({ workspaceId }: { workspaceId: string }) {
  const { events, loading } = useLiveEvents(workspaceId, 4)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '2px 2px 10px' }}>
        <span aria-hidden style={{
          width: 6, height: 6, borderRadius: '50%', background: events.length > 0 ? '#34d399' : LABEL_COLOR,
        }} />
        <span style={{
          fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR,
        }}>
          Live
        </span>
      </div>

      {!loading && events.length === 0 && (
        <p style={{ fontSize: 12.5, color: LABEL_COLOR, padding: '4px 2px' }}>Nothing in motion right now.</p>
      )}

      {events.map((e, i) => {
        const { title, subtitle } = splitLabel(e.label)
        return (
          <div
            key={e.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 11, padding: '9px 4px',
              borderTop: i === 0 ? 'none' : `1px solid ${CARD_BORDER}`,
              animation: 'caye-view-in 0.2s ease-out',
            }}
          >
            <EventIcon type={e.type} tone={e.tone} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 600, color: '#f4f4f5',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {title}
              </div>
              {subtitle && (
                <div style={{
                  fontSize: 11.5, color: LABEL_COLOR, marginTop: 1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {subtitle}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: LABEL_COLOR, fontFamily: 'var(--font-mono)' }}>{relTime(e.at, now)}</span>
              <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: TONE_COLOR[e.tone] }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
