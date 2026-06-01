'use client'

import HomeScreen from '@/components/dashboard/home/HomeScreen'
import CayePanel from '@/components/dashboard/CayePanel'
import { useDashboard } from '@/lib/dashboard-context'

export default function DashboardPage() {
  const { panelOpen, setPanelOpen } = useDashboard()

  return (
    <div className="tc-content" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden' }}>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
        <HomeScreen />
      </main>
      <CayePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </div>
  )
}

