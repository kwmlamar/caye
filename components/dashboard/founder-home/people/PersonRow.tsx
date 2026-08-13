'use client'

import { useState } from 'react'
import { formatDistanceToNow } from '@/lib/utils'
import { TEXT, TEXT_QUIET, GOLD, AQUA, rowDivider } from '../../surface'
import type { PersonSummary } from '@/lib/people'

/**
 * "Communicate Caye's understanding of the relationship" — not a database
 * row. WHO (name/company) is the only bold line; everything else is quiet
 * hierarchy via spacing and color, not boxes or badges. rowContext and
 * nextAction are both optional-in-spirit (deriveProspect/deriveCustomer
 * never invent filler — see lib/people.ts), so this renders whatever's
 * genuinely there rather than reserving fixed slots.
 */
export default function PersonRow({ person, active, onClick }: {
  person: PersonSummary
  active: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const stateColor = person.needsYou ? GOLD : person.state === 'engaged' || person.state === 'converted' ? AQUA : TEXT_QUIET

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
        padding: '11px 14px 11px 18px', borderRadius: 10, borderTop: rowDivider,
        background: active ? 'rgba(78,190,206,0.06)' : hover ? 'rgba(255,255,255,0.03)' : 'transparent',
        transition: 'background 0.12s ease',
      }}
    >
      {active && (
        <span aria-hidden style={{
          position: 'absolute', left: 4, top: 9, bottom: 9, width: 2, borderRadius: 2,
          background: AQUA, boxShadow: `0 0 6px ${AQUA}77`,
        }} />
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
            <span style={{
              fontSize: 13.5, fontWeight: 600, color: TEXT,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {person.name}
            </span>
            {person.company && person.company !== person.name && (
              <span style={{ fontSize: 12, color: TEXT_QUIET, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {person.company}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 12, minWidth: 0 }}>
            {person.needsYou && (
              <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: GOLD, flexShrink: 0 }} />
            )}
            <span style={{ color: stateColor, fontWeight: person.needsYou ? 600 : 500, flexShrink: 0 }}>{person.stateLabel}</span>
            {person.rowContext && (
              <>
                <span style={{ color: 'rgba(255,255,255,0.15)', flexShrink: 0 }}>·</span>
                <span style={{ color: TEXT_QUIET, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person.rowContext}</span>
              </>
            )}
          </div>
        </div>
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <div style={{ fontSize: 11.5, color: person.needsYou ? GOLD : TEXT_QUIET, fontWeight: person.needsYou ? 600 : 400 }}>
            {person.nextAction}
          </div>
          {person.lastInteractionAt && (
            <div style={{ fontSize: 10.5, color: TEXT_QUIET, marginTop: 3 }}>{formatDistanceToNow(person.lastInteractionAt)}</div>
          )}
        </div>
      </div>
    </button>
  )
}
