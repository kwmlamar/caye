'use client'

import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CayeLog from './CayeLog'
import type { CommandOverview } from '@/lib/useCommandOverview'

const CARD_BG = '#1a1a1e'
const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

// What Caye is doing (Home's "Working now"), has done (the full log
// here), and plans to do (the calendar here) — the calendar and the
// complete activity history both moved off Home, where they were
// crowding out the briefing with operational detail nobody reads at a
// glance.
export default function WorkPage({
  workspaceId, data, weekOffset, onWeekOffsetChange, onSelectConversation,
}: {
  workspaceId: string
  data: CommandOverview | null
  weekOffset: number
  onWeekOffsetChange: (offset: number) => void
  onSelectConversation: (conversationId: string | null) => void
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ flexShrink: 0, height: 460, borderRadius: 16, overflow: 'hidden', background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        {data ? (
          <CommandCalendar
            workspaceId={workspaceId}
            bookings={data.bookings}
            weekStart={data.week_start}
            weekOffset={weekOffset}
            onWeekOffsetChange={onWeekOffsetChange}
            onSelectConversation={onSelectConversation}
          />
        ) : (
          <div style={{ padding: 20, fontSize: 12.5, color: LABEL_COLOR }}>Loading…</div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 300, borderRadius: 16, background: CARD_BG, border: `1px solid ${CARD_BORDER}`, padding: '14px 16px', overflowY: 'auto' }}>
        <CayeLog workspaceId={workspaceId} limit={60} />
      </div>
    </div>
  )
}
