'use client'

import CommandConversations from '@/components/dashboard/command-conversations/CommandConversations'

const CARD_BG = '#1a1a1e'
const CARD_BORDER = '#28282d'

export default function InboxPage({ workspaceId, selectedConversationId, onSent }: {
  workspaceId: string
  selectedConversationId: string | null
  onSent: () => void
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, padding: 20, display: 'flex' }}>
      <div style={{ flex: 1, minHeight: 0, borderRadius: 16, overflow: 'hidden', background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <CommandConversations workspaceId={workspaceId} selectedConversationId={selectedConversationId} onSent={onSent} />
      </div>
    </div>
  )
}
