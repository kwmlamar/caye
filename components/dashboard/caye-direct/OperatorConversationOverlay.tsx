'use client'

import { popoverSurface, paneShadow, TEXT_QUIET } from '@/components/dashboard/surface'
import CayeDirectThread from './CayeDirectThread'

/**
 * Read-only observability into one business operator's raw WhatsApp
 * history with Caye (Max, Mrs. Max) — 2026-08-13 redesign. Operators no
 * longer occupy the main Direct sidebar (that's the founder's own topic-
 * thread history now); this is where their conversations moved to.
 *
 * Wraps CayeDirectThread in its 'operator' mode, which is ALWAYS read-only
 * — there is no composer, no write path, nothing for this overlay to
 * accidentally expose. See CayeDirectThread's mode union and
 * app/api/founder/caye-direct/route.ts's doc comment for the server-side
 * half of that guarantee.
 */
export default function OperatorConversationOverlay({
  workspaceId,
  operatorId,
  operatorLabel,
  onClose,
}: {
  workspaceId: string
  operatorId: number
  operatorLabel: string
  onClose: () => void
}) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'flex-end' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
      <div
        style={{
          position: 'relative', width: 420, maxWidth: '92vw', height: '100%',
          display: 'flex', flexDirection: 'column',
          ...popoverSurface(), boxShadow: paneShadow,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{operatorLabel}</div>
            <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: TEXT_QUIET }}>WhatsApp · read only</div>
          </div>
          <button
            onClick={onClose}
            title="Close"
            style={{
              width: 28, height: 28, borderRadius: 8, border: 'none', cursor: 'pointer',
              background: 'rgba(255,255,255,0.08)', color: '#a1a1aa',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <CayeDirectThread mode="operator" workspaceId={workspaceId} operatorId={operatorId} operatorLabel={operatorLabel} />
        </div>
      </div>
    </div>
  )
}
