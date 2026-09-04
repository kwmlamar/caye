'use client'

import { useState, type ReactNode } from 'react'
import ChannelsCard from './ChannelsCard'
import JobSearchMailCard from './JobSearchMailCard'
import SettingsCard from './SettingsCard'
import CostPage from './CostPage'
import HealthPage from './HealthPage'
import ToolsPage from './ToolsPage'
import AiProvidersPage from './AiProvidersPage'
import AdminShell from '@/components/dashboard/admin-shell/AdminShell'
import GlobalPerformance from '@/components/dashboard/global-performance/GlobalPerformance'
import { selectedRow } from '@/components/dashboard/surface'

const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

type WorkspaceTab = 'caye' | 'channels'
type OperationsTab = 'performance' | 'cost' | 'health' | 'ai' | 'tools' | 'admin'
type Tab = WorkspaceTab | OperationsTab

const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'caye', label: 'Caye' },
  { id: 'channels', label: 'Channels' },
]
const OPERATIONS_TABS: { id: OperationsTab; label: string }[] = [
  { id: 'performance', label: 'Performance' },
  { id: 'cost', label: 'Cost' },
  { id: 'health', label: 'Health' },
  // Internal AI-provider infrastructure. Sits under Operations, next to
  // Health and Cost, because that is where the founder already goes when
  // something is wrong — not a customer-visible setting.
  { id: 'ai', label: 'AI providers' },
  { id: 'tools', label: 'Tools' },
  { id: 'admin', label: 'Admin' },
]

function TabButton({ label, active, onClick, quiet }: { label: string; active: boolean; onClick: () => void; quiet?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none', cursor: 'pointer', textAlign: 'left', padding: '7px 12px', borderRadius: 9,
        fontSize: quiet ? 12.5 : 13, fontWeight: active ? 600 : 500,
        color: active ? '#f4f4f5' : quiet ? '#71717a' : '#a1a1aa',
        background: active ? undefined : 'transparent',
        ...selectedRow(active),
      }}
    >
      {label}
    </button>
  )
}

function NavSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, padding: '4px 12px 6px' }}>
      {children}
    </div>
  )
}

export default function SettingsPage({ workspaceId }: { workspaceId: string }) {
  const [tab, setTab] = useState<Tab>('caye')

  let body: ReactNode
  switch (tab) {
    case 'caye': body = <div style={{ padding: 20, display: 'flex', flexDirection: 'column' }}><SettingsCard workspaceId={workspaceId} compact={false} /></div>; break
    case 'channels': body = <div style={{ padding: 20 }}><ChannelsCard workspaceId={workspaceId} /><JobSearchMailCard /></div>; break
    case 'performance': body = <GlobalPerformance />; break
    case 'cost': body = <CostPage />; break
    case 'health': body = <HealthPage />; break
    case 'ai': body = <AiProvidersPage />; break
    case 'tools': body = <ToolsPage />; break
    case 'admin': body = <AdminShell />; break
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <nav style={{ width: 190, flexShrink: 0, borderRight: `1px solid ${CARD_BORDER}`, padding: '18px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <NavSectionLabel>Settings</NavSectionLabel>
        {WORKSPACE_TABS.map((t) => (
          <TabButton key={t.id} label={t.label} active={tab === t.id} onClick={() => setTab(t.id)} />
        ))}

        <div style={{ marginTop: 22 }} />
        <NavSectionLabel>Operations</NavSectionLabel>
        {OPERATIONS_TABS.map((t) => (
          <TabButton key={t.id} label={t.label} active={tab === t.id} onClick={() => setTab(t.id)} quiet />
        ))}
      </nav>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 24px 110px' }}>
        <div style={{ width: '100%', maxWidth: 1180, margin: '0 auto' }}>
          {body}
        </div>
      </div>
    </div>
  )
}
