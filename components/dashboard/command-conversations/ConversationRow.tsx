'use client'

import { useState } from 'react'
import { formatDistanceToNow } from '@/lib/utils'
import { AQUA, GOLD, TEXT, TEXT_QUIET } from '@/components/dashboard/surface'
import { channelLabel } from './channel-meta'
import type { ConversationSummary } from '@/lib/useFounderConversations'

// human_agent_reason is built server-side from pingSummary/internalContext
// (see lib/whatsapp/escalation.ts) — both are already prompted/templated
// to be plain founder-readable prose as of this pass. The one thing worth
// trimming client-side is the "Escalation (category): " label prefix
// that gets prepended for the row/hold reason specifically — that's
// internal taxonomy, not something worth spending row width on when the
// state is already shown by the dot + "Needs you" text below it.
function cleanReason(reason: string | null): string {
  if (!reason) return 'Needs your review'
  return reason.replace(/^Escalation \([a-z_]+\):\s*/i, '')
}

export default function ConversationRow({ c, active, onClick }: {
  c: ConversationSummary
  active: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const name = c.customer_name || c.customer_id || 'Unknown'
  const preview = c.human_agent_enabled ? cleanReason(c.human_agent_reason) : (c.last_message_preview || '')

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
        background: active ? 'rgba(78,190,206,0.07)' : hover ? 'rgba(255,255,255,0.03)' : 'transparent',
        borderRadius: 10, padding: '10px 12px 10px 16px', marginBottom: 1,
        transition: 'background 0.12s ease',
      }}
    >
      {active && (
        <span aria-hidden style={{
          position: 'absolute', left: 4, top: 9, bottom: 9, width: 2, borderRadius: 2,
          background: AQUA, boxShadow: `0 0 6px ${AQUA}77`,
        }} />
      )}
      <div style={{
        fontSize: 13, fontWeight: active ? 600 : 500, color: active ? TEXT : 'rgba(245,245,244,0.82)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {name}
      </div>
      <p style={{
        fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        color: c.human_agent_enabled ? 'rgba(255,228,175,0.75)' : TEXT_QUIET,
      }}>
        {preview}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 10.5, color: TEXT_QUIET }}>
          {channelLabel(c.channel_type)} · {formatDistanceToNow(c.last_message_at)}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
        {c.human_agent_enabled ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, color: GOLD }}>
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: GOLD }} />
            Needs you
          </span>
        ) : (
          <span style={{ fontSize: 10.5, color: TEXT_QUIET }}>Caye handling</span>
        )}
      </div>
    </button>
  )
}
