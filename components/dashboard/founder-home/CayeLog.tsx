'use client'

import { useLiveEvents } from '@/lib/useLiveEvents'
import { clockTime, TONE_COLOR } from './event-visuals'
import { glass, rowDivider, TEXT_QUIET, AQUA } from '../surface'

// A founder reading what their employee got done, not a server log —
// plain sentences, no operation_id, no status=true. Same workspace_events
// data as LiveActivity, just deeper and rendered as history instead of
// "in motion right now." Home uses a short `limit` + onViewAll link into
// the full history on the Work page; Work itself passes a large limit and
// no onViewAll, since it IS the full view.
export default function CayeLog({ workspaceId, limit = 25, onViewAll }: {
  workspaceId: string
  limit?: number
  onViewAll?: () => void
}) {
  const { events, loading } = useLiveEvents(workspaceId, limit)

  return (
    <div style={{ ...glass(0.018), borderRadius: 18, padding: '18px 20px', display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto' }}>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px 12px' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e4e4e7' }}>
          Caye's log
        </span>
      </div>

      {!loading && events.length === 0 && (
        <p style={{ fontSize: 12.5, color: TEXT_QUIET, padding: '4px 2px' }}>No activity recorded yet.</p>
      )}

      {events.map((e, i) => (
        <div
          key={e.id}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 12, padding: '9px 4px',
            borderTop: i === 0 ? 'none' : rowDivider,
          }}
        >
          <span style={{
            fontSize: 11, fontFamily: 'var(--font-mono)', color: TEXT_QUIET,
            flexShrink: 0, width: 66,
          }}>
            {clockTime(e.at)}
          </span>
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: TONE_COLOR[e.tone], flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: '#e4e4e7', lineHeight: 1.4 }}>{e.label}.</span>
        </div>
      ))}

      {onViewAll && events.length > 0 && (
        <button
          onClick={onViewAll}
          style={{
            alignSelf: 'flex-start', marginTop: 10, border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 12, color: AQUA, padding: '4px 2px', fontFamily: 'var(--font-sans)',
          }}
        >
          View activity →
        </button>
      )}
    </div>
  )
}
