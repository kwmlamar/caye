'use client'

import HomeScreen from '@/components/dashboard/home/HomeScreen'
import CayePanel from '@/components/dashboard/CayePanel'
import { useDashboard } from '@/lib/dashboard-context'
import { useWorkspace } from '@/lib/workspace-context'

export default function DashboardPage() {
  const { panelOpen, setPanelOpen } = useDashboard()
  const { isFounder } = useWorkspace()

  return (
    <div className="tc-content" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden' }}>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
        <HomeScreen />
      </main>
      {/* Right panel (Inbox / Bookings / Calendar / Contacts) is a
          founder-only surface. Operators (Karenda etc.) live in Caye-on-
          WhatsApp per the dashboard scope lock in CLAUDE.md. */}
      {isFounder && <CayePanel open={panelOpen} onClose={() => setPanelOpen(false)} />}
    </div>
  )
}

