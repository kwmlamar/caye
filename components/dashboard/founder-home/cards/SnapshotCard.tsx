'use client'

import { useState } from 'react'
import type { CommandOverview } from '@/lib/useCommandOverview'
import type { TodayStats } from '@/lib/useTodayStats'
import AttentionCard from '../AttentionCard'
import BusinessPulse from '../BusinessPulse'
import { TEXT_QUIET } from '../../surface'

/**
 * The first entry in Caye's card catalog — the founder's daily snapshot
 * (bookings, revenue, anything needing a decision). This is the old
 * FounderHome hero's content relocated, not new data: same
 * useCommandOverview/useTodayStats hooks, same AttentionCard/BusinessPulse
 * components, so it stays accurate without a second data path.
 *
 * Renders as Caye's opening message on a genuinely empty thread (passed
 * as CayeDirectThread's `leadingCard`) — NOT pinned above the conversation
 * as an external header. That used to squeeze the composer off-screen on
 * a long attention item, since a sibling with unbounded content height
 * competing with the transcript for space breaks the "composer is always
 * visible" guarantee. Living inside the same scroll region CayeDirectThread
 * already manages correctly removes that failure mode entirely, and
 * matches the original "cards render inline like a message" call from the
 * redesign's planning pass.
 *
 * Deliberately quiet — no card chrome (border/shadow/label row) beyond the
 * sender identity every Caye message already carries. The goal is "Caye
 * mentioned this in passing," not a dashboard widget bolted onto a chat
 * window. When there's nothing needing a decision, it renders just the
 * three numbers and stops; it never manufactures a "you're all caught up"
 * line to fill the space.
 *
 * Card selection (Caye choosing to drop a card mid-conversation, from
 * lib/caye-agent tool calls) is intentionally NOT wired here — the agent's
 * tool-call ledger (caye_tool_calls) is deliberately content-free by
 * design (see investigation.ts), so surfacing real tool-result data as a
 * card requires a real persistence decision (new column or table), not a
 * shortcut through that ledger. This card is placed by the page itself,
 * the same way Home always was; it's the seed of the catalog and the
 * visual contract for what a card looks like, not the full mechanism.
 */
export default function SnapshotCard({
  data, today, weekLabel, onReviewAttention, onDismiss,
}: {
  data: CommandOverview | null
  today: TodayStats | null
  weekLabel: string
  onReviewAttention: (conversationId: string | null) => void
  onDismiss: () => void
}) {
  const [hover, setHover] = useState(false)
  if (!data) return null

  const hasAttention = data.pending_escalation_count > 0

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss snapshot"
        title="Dismiss"
        style={{
          position: 'absolute', top: -2, right: -6, width: 22, height: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 0, borderRadius: 6, background: 'transparent', color: TEXT_QUIET, cursor: 'pointer',
          opacity: hover ? 1 : 0, transition: 'opacity 0.15s ease, background 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>

      <BusinessPulse data={data} today={today} weekLabel={weekLabel} />
      {hasAttention && (
        <div style={{ marginTop: 16 }}>
          <AttentionCard escalations={data.escalations} onReview={onReviewAttention} />
        </div>
      )}
    </div>
  )
}
