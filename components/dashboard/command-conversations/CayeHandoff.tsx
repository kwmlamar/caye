'use client'

import { useState } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { formatDistanceToNow } from '@/lib/utils'
import { GOLD, TEXT, TEXT_QUIET, rowDivider } from '@/components/dashboard/surface'

const CATEGORY_LABEL: Record<string, string> = {
  gap: 'Something Caye couldn\'t verify',
  policy: 'A policy call',
  knowledge: 'Something Caye doesn\'t know yet',
  sensitive: 'Needs your personal judgment',
}
const ROUTE_LABEL: Record<string, string> = { owner: 'You', founder: 'The founder', both: 'You and the founder' }

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderTop: rowDivider }}>
      <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: TEXT_QUIET, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: 12.5, color: TEXT, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

/**
 * Caye quietly tapping the founder on the shoulder — replaces the old
 * "Internal Note" box that dumped raw internal_context verbatim.
 *
 * `note` is internal_context as written by the escalation pipeline. As of
 * this pass every write path (lib/caye-reply.ts's escalate_to_team tool,
 * lib/forced-escalation.ts, lib/standing-rules.ts) is prompted/templated
 * to produce plain founder-readable prose — no rewriting happens here,
 * because there's nothing to translate anymore. Rows written before this
 * pass may still carry the old machine-templated text; that's a data
 * migration question, not something to paper over client-side.
 *
 * Progressive disclosure below is deliberately thin: category and
 * route-to are the only structured fields that actually persist to
 * caye_escalations. There is no stored "confidence" or "policy id" to
 * reveal — showing one would mean inventing it.
 */
export default function CayeHandoff({
  note, category, routeTo, at, onReply, resolved,
}: {
  note: string
  category: string | null
  routeTo: string | null
  at: string | null
  onReply?: () => void
  resolved: boolean
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)

  return (
    <div style={{
      alignSelf: 'stretch', borderRadius: 14, padding: '14px 16px',
      background: 'rgba(255,228,175,0.045)',
      boxShadow: '0 1px 0 rgba(255,255,255,0.03) inset, 0 0 32px -14px rgba(255,228,175,0.28)',
      animation: resolved ? 'caye-resolve-out 0.35s ease forwards' : 'caye-view-in 0.25s ease-out',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span aria-hidden style={{ display: 'flex' }}><CayeMark size={15} /></span>
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: GOLD }}>
          Needs you
        </span>
        {at && <span style={{ fontSize: 11, color: TEXT_QUIET }}>· {formatDistanceToNow(at)}</span>}
      </div>

      <p style={{ fontSize: 13.5, lineHeight: 1.6, color: TEXT, margin: 0, opacity: 0.94, maxWidth: 560 }}>{note}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12 }}>
        {onReply && (
          <button
            onClick={onReply}
            style={{
              border: 'none', cursor: 'pointer', borderRadius: 9, padding: '6px 14px',
              fontSize: 12.5, fontWeight: 600, color: GOLD, background: 'rgba(255,228,175,0.14)',
            }}
          >
            Reply
          </button>
        )}
        {(category || routeTo) && (
          <button
            onClick={() => setDetailsOpen((o) => !o)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, color: TEXT_QUIET, padding: 0 }}
          >
            {detailsOpen ? 'Hide details' : 'Why did Caye escalate this?'}
          </button>
        )}
      </div>

      {detailsOpen && (
        <div style={{ marginTop: 10 }}>
          {category && <DetailRow label="Category" value={CATEGORY_LABEL[category] ?? category} />}
          {routeTo && <DetailRow label="Routed to" value={ROUTE_LABEL[routeTo] ?? routeTo} />}
        </div>
      )}
    </div>
  )
}
