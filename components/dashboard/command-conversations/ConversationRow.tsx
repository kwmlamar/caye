'use client'

import { useState } from 'react'
import { formatDistanceToNow } from '@/lib/utils'
import { AQUA, GOLD, TEXT, TEXT_QUIET } from '@/components/dashboard/surface'
import { conversationNeedsFounder, cleanHoldReason } from '@/lib/hold-kinds-shared'
import { channelLabel } from './channel-meta'
import type { ConversationSummary } from '@/lib/useFounderConversations'

export default function ConversationRow({ c, active, onClick }: {
  c: ConversationSummary
  active: boolean
  onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const name = c.customer_name || c.customer_id || 'Unknown'
  // human_agent_enabled alone doesn't mean the founder owes the next move —
  // drafted cold outreach parked for batch approval sets it too. This is the
  // same predicate the Needs You tab's server query filters on
  // (isAttentionHold(holdKindOf(metadata))), so a row badged "Needs you"
  // here always appears in that tab, and vice versa.
  const needsYou = conversationNeedsFounder(c)
  const preview = c.human_agent_enabled ? cleanHoldReason(c.human_agent_reason) : (c.last_message_preview || '')

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
        color: needsYou ? 'rgba(255,228,175,0.75)' : TEXT_QUIET,
      }}>
        {preview}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        <span style={{ fontSize: 10.5, color: TEXT_QUIET }}>
          {channelLabel(c.channel_type)} · {formatDistanceToNow(c.last_message_at)}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
        {needsYou ? (
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
