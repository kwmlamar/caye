'use client'

import { useState } from 'react'
import { AQUA, GOLD, TEXT, TEXT_QUIET, rowDivider } from '../../surface'

export interface MemoryItemData {
  id: string
  text: string
  /** neutral = advisory knowledge (aqua dot). gold = enforced or needing
   *  the founder's attention (standing rules, open clarifications). */
  tone: 'neutral' | 'gold'
  metaLeft?: string
  metaRight?: string
  /** Real fields only — id, enum values, timestamps. Never fabricated
   *  ("confidence", "policy id") — see MemoryPage's audit notes. */
  technical: { label: string; value: string }[]
}

const CLAMP_THRESHOLD = 140

export default function MemoryItem({ item, first }: { item: MemoryItemData; first: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [showTechnical, setShowTechnical] = useState(false)
  const long = item.text.length > CLAMP_THRESHOLD
  const canExpand = long || item.technical.length > 0
  const dotColor = item.tone === 'gold' ? GOLD : AQUA

  return (
    <div style={{ borderTop: first ? 'none' : rowDivider, padding: '12px 4px' }}>
      <button
        onClick={() => canExpand && setExpanded((e) => !e)}
        aria-expanded={canExpand ? expanded : undefined}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', textAlign: 'left',
          border: 'none', background: 'transparent', padding: 0,
          cursor: canExpand ? 'pointer' : 'default',
        }}
      >
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0, marginTop: 6 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: 13.5, lineHeight: 1.55, color: TEXT, margin: 0,
            display: expanded || !long ? 'block' : '-webkit-box',
            WebkitLineClamp: expanded || !long ? undefined : 2,
            WebkitBoxOrient: expanded || !long ? undefined : 'vertical',
            overflow: expanded || !long ? 'visible' : 'hidden',
          }}>
            {item.text}
          </p>
          {(item.metaLeft || item.metaRight) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 5 }}>
              <span style={{ fontSize: 11.5, color: TEXT_QUIET }}>{item.metaLeft}</span>
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: TEXT_QUIET, flexShrink: 0, whiteSpace: 'nowrap' }}>{item.metaRight}</span>
            </div>
          )}
        </div>
        {canExpand && (
          <svg
            aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={TEXT_QUIET} strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, marginTop: 6, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {expanded && item.technical.length > 0 && (
        <div style={{ marginTop: 10, paddingLeft: 16 }}>
          <button
            onClick={() => setShowTechnical((s) => !s)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11, color: TEXT_QUIET, textDecoration: 'underline', textUnderlineOffset: 2 }}
          >
            {showTechnical ? 'Hide technical details' : 'Technical details'}
          </button>
          {showTechnical && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {item.technical.map((t) => (
                <div key={t.label} style={{ display: 'flex', gap: 10, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                  <span style={{ color: TEXT_QUIET, minWidth: 90 }}>{t.label}</span>
                  <span style={{ color: 'rgba(245,245,244,0.6)', wordBreak: 'break-all' }}>{t.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
