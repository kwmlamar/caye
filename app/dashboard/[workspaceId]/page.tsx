'use client'

import HomeScreen from '@/components/dashboard/home/HomeScreen'
import FounderHome from '@/components/dashboard/founder-home/FounderHome'
import { useWorkspace } from '@/lib/workspace-context'

// 2026-07-02: founders get one full-page view (FounderHome — its own
// workspaces list, stats, calendar, and conversations all in one
// layout, no slide-out panel). Owners (e.g. Karenda) keep HomeScreen
// exactly as it was — this redesign never touches their surface.
export default function DashboardPage() {
  const { isFounder } = useWorkspace()

  return (
    <div className="tc-content" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden' }}>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, minHeight: 0 }}>
        {isFounder ? <FounderHome /> : <HomeScreen />}
      </main>
    </div>
  )
}

