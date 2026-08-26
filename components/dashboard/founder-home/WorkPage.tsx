'use client'

import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CayeLog from './CayeLog'
import { glass } from '../surface'

// What Caye is doing (Home's "Working now"), has done (the full log
// here), and plans to do (the calendar here) — the calendar and the
// complete activity history both moved off Home, where they were
// crowding out the briefing with operational detail nobody reads at a
// glance.
export default function WorkPage({
  workspaceId, onSelectConversation,
}: {
  workspaceId: string
  onSelectConversation: (conversationId: string | null) => void
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px 24px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ ...glass(0.018), flexShrink: 0, height: 460, borderRadius: 18, overflow: 'hidden' }}>
        <CommandCalendar workspaceId={workspaceId} onSelectConversation={onSelectConversation} />
      </div>
      <div style={{ flex: 1, minHeight: 300 }}>
        <CayeLog workspaceId={workspaceId} limit={60} />
      </div>
    </div>
  )
}
