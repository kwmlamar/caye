'use client'

import CommandCalendar from '@/components/dashboard/command-calendar/CommandCalendar'
import CayeLog from './CayeLog'
import { glass } from '../surface'

export default function WorkPage({
  workspaceId, onSelectConversation,
}: {
  workspaceId: string
  onSelectConversation: (conversationId: string | null) => void
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px 24px 110px' }}>
      <div style={{ width: '100%', maxWidth: 1180, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ ...glass(0.018), flexShrink: 0, height: 460, borderRadius: 18, overflow: 'hidden' }}>
          <CommandCalendar workspaceId={workspaceId} onSelectConversation={onSelectConversation} />
        </div>
        <div style={{ flex: 1, minHeight: 300 }}>
          <CayeLog workspaceId={workspaceId} limit={60} />
        </div>
      </div>
    </div>
  )
}
