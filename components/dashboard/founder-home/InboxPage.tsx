'use client'

import CommandConversations from '@/components/dashboard/command-conversations/CommandConversations'

// No wrapping card — the Inbox occupies the page directly. Separation
// between the list and thread panes is CommandConversations' own
// vertical divider, not a rounded rectangle around the whole thing.
export default function InboxPage({ workspaceId, selectedConversationId, onSent }: {
  workspaceId: string
  selectedConversationId: string | null
  onSent: () => void
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <CommandConversations workspaceId={workspaceId} selectedConversationId={selectedConversationId} onSent={onSent} />
    </div>
  )
}
