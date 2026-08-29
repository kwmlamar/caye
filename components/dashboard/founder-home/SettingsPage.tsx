'use client'

import { useState, type ReactNode } from 'react'
import ChannelsCard from './ChannelsCard'
import JobSearchMailCard from './JobSearchMailCard'
import SettingsCard from './SettingsCard'
import CostPage from './CostPage'
import HealthPage from './HealthPage'
import ToolsPage from './ToolsPage'
import AdminShell from '@/components/dashboard/admin-shell/AdminShell'
import GlobalPerformance from '@/components/dashboard/global-performance/GlobalPerformance'

const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

type WorkspaceTab = 'caye' | 'channels'
type OperationsTab = 'performance' | 'cost' | 'health' | 'tools' | 'admin'
type Tab = WorkspaceTab | OperationsTab

// Two distinct groups sharing one nav column, not seven equal-weight
// destinations (2026-08-26 redesign — see Products/Caye/CLAUDE.md's
// audit notes). "Workspace" is what this founder-viewed workspace's Caye
// is configured to do — the same conceptual surface a workspace owner's
// own Settings covers, just reached from the founder's console instead
// of components/settings/* (that light-themed owner surface is untouched
// by this change; the two have always been separate implementations, see
// app/dashboard/[workspaceId]/settings/page.tsx vs. this file).
// "Operations" is founder-only machinery inspection — cross-workspace
// performance/cost, infra health, the raw tool registry, and the dev/ops
// console — visually demoted (smaller label, tucked lower, its own
// section heading) so it doesn't read as more workspace settings.
const WORKSPACE_TABS: { id: WorkspaceTab; label: string }[] = [
  { id: 'caye', label: 'Caye' },
  { id: 'channels', label: 'Channels' },
]
const OPERATIONS_TABS: { id: OperationsTab; label: string }[] = [
  { id: 'performance', label: 'Performance' },
  { id: 'cost', label: 'Cost' },
  { id: 'health', label: 'Health' },
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
        background: active ? 'rgba(78,190,206,0.1)' : 'transparent',
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

// Configuration, integrations, and founder power tools — deliberately off
// Home. This is where they moved to, not where they died: everything that
// was on the old dashboard's Channels/Settings/Cost/Health/Tools/Admin
// Shell rail destinations still exists, just consolidated under one
// secondary surface instead of six parallel nav icons.
export default function SettingsPage({ workspaceId }: { workspaceId: string }) {
  const [tab, setTab] = useState<Tab>('caye')

  let body: ReactNode
  switch (tab) {
    case 'caye': body = <div style={{ padding: 20, display: 'flex', flexDirection: 'column' }}><SettingsCard workspaceId={workspaceId} compact={false} /></div>; break
    case 'channels': body = <div style={{ padding: 20 }}><ChannelsCard workspaceId={workspaceId} /><JobSearchMailCard /></div>; break
    case 'performance': body = <GlobalPerformance />; break
    case 'cost': body = <CostPage />; break
    case 'health': body = <HealthPage />; break
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
      {/* paddingBottom clears the floating global composer. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto', paddingBottom: 96 }}>
        {body}
      </div>
    </div>
  )
}
