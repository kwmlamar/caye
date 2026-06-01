'use client'

import { useWorkspace } from '@/lib/workspace-context'

export type TabId = 'general' | 'caye' | 'workspace' | 'billing'

interface SettingsNavProps {
  active: TabId
  setActive: (tab: TabId) => void
}

export default function SettingsNav({ active, setActive }: SettingsNavProps) {
  const { workspace } = useWorkspace()
  const bizName = (workspace?.business_name || 'my workspace').toLowerCase()
  const tz = workspace?.timezone
    ? workspace.timezone.split('/')[1]?.replace(/_/g, ' ').toLowerCase() || workspace.timezone
    : ''

  const tabs: { id: TabId; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'caye', label: 'Caye AI' },
    { id: 'workspace', label: 'Workspace' },
    { id: 'billing', label: 'Billing' },
  ]

  return (
    <aside className="set-nav">
      <div className="set-nav-head">
        <div className="set-nav-title">Settings</div>
        <div className="set-nav-org">{bizName}{tz ? ` · ${tz}` : ''}</div>
      </div>
      <nav className="set-nav-list">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={'set-nav-item' + (active === tab.id ? ' active' : '')}
            onClick={() => setActive(tab.id)}
          >
            <span className="sn-text">
              <span className="sn-label">{tab.label}</span>
            </span>
          </button>
        ))}
      </nav>
    </aside>
  )
}
