'use client'

import ContactsPanel from './ContactsPanel'

export default function PeoplePage({ workspaceId }: { workspaceId: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <ContactsPanel workspaceId={workspaceId} />
    </div>
  )
}
