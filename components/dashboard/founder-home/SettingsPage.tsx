'use client'

import { useState, type ReactNode } from 'react'
import ChannelsCard from './ChannelsCard'
import SettingsCard from './SettingsCard'
import CostPage from './CostPage'
import HealthPage from './HealthPage'
import ToolsPage from './ToolsPage'
import AdminShell from '@/components/dashboard/admin-shell/AdminShell'
import GlobalPerformance from '@/components/dashboard/global-performance/GlobalPerformance'

const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

type Tab = 'channels' | 'voice' | 'performance' | 'cost' | 'health' | 'tools' | 'admin'

const TABS: { id: Tab; label: string }[] = [
  { id: 'channels', label: 'Channels' },
  { id: 'voice', label: 'Voice & knowledge' },
  { id: 'performance', label: 'Performance' },
  { id: 'cost', label: 'Cost' },
  { id: 'health', label: 'Health' },
  { id: 'tools', label: 'Tools' },
  { id: 'admin', label: 'Admin' },
]

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none', cursor: 'pointer', textAlign: 'left', padding: '8px 12px', borderRadius: 9,
        fontSize: 13, fontWeight: active ? 600 : 500, color: active ? '#f4f4f5' : '#a1a1aa',
        background: active ? 'rgba(78,190,206,0.1)' : 'transparent',
      }}
    >
      {label}
    </button>
  )
}

// Configuration, integrations, and founder power tools — deliberately off
// Home. This is where they moved to, not where they died: everything that
// was on the old dashboard's Channels/Settings/Cost/Health/Tools/Admin
// Shell rail destinations still exists, just consolidated under one
// secondary surface instead of six parallel nav icons.
export default function SettingsPage({ workspaceId }: { workspaceId: string }) {
  const [tab, setTab] = useState<Tab>('channels')

  let body: ReactNode
  switch (tab) {
    case 'channels': body = <div style={{ padding: 20 }}><ChannelsCard workspaceId={workspaceId} /></div>; break
    case 'voice': body = <div style={{ padding: 20, display: 'flex', flexDirection: 'column' }}><SettingsCard workspaceId={workspaceId} compact={false} /></div>; break
    case 'performance': body = <GlobalPerformance />; break
    case 'cost': body = <CostPage />; break
    case 'health': body = <HealthPage />; break
    case 'tools': body = <ToolsPage />; break
    case 'admin': body = <AdminShell />; break
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <nav style={{ width: 190, flexShrink: 0, borderRight: `1px solid ${CARD_BORDER}`, padding: '18px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: LABEL_COLOR, padding: '4px 12px 10px' }}>
          Settings
        </div>
        {TABS.map((t) => (
          <TabButton key={t.id} label={t.label} active={tab === t.id} onClick={() => setTab(t.id)} />
        ))}
      </nav>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        {body}
      </div>
    </div>
  )
}
