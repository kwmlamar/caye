'use client'

import HomeScreen from '@/components/dashboard/home/HomeScreen'
import CayePanel from '@/components/dashboard/CayePanel'
import { useDashboard } from '@/lib/dashboard-context'

export default function DashboardPage() {
  const { panelOpen, setPanelOpen } = useDashboard()

  return (
    <>
      <main className="tc-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <HomeScreen />
      </main>
      <CayePanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </>
  )
}

