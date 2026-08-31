'use client'

import CommandConversations from '@/components/dashboard/command-conversations/CommandConversations'

export default function InboxPage({ workspaceId, selectedConversationId, onSent }: {
  workspaceId: string
  selectedConversationId: string | null
  onSent: () => void
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', justifyContent: 'center', padding: '20px 24px 96px' }}>
      <div style={{ width: '100%', maxWidth: 1180, minHeight: 0, display: 'flex' }}>
        <CommandConversations workspaceId={workspaceId} selectedConversationId={selectedConversationId} onSent={onSent} />
      </div>
    </div>
  )
}
