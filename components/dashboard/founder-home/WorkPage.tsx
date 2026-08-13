'use client'

import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CayeLog from './CayeLog'
import type { CommandOverview } from '@/lib/useCommandOverview'
import { glass, TEXT_QUIET } from '../surface'

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
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ ...glass(0.018), flexShrink: 0, height: 460, borderRadius: 18, overflow: 'hidden' }}>
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
          <div style={{ padding: 20, fontSize: 12.5, color: TEXT_QUIET }}>Loading…</div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 300 }}>
        <CayeLog workspaceId={workspaceId} limit={60} />
      </div>
    </div>
  )
}
