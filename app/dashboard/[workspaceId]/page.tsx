'use client'

import HomeScreen from '@/components/dashboard/home/HomeScreen'
import FounderHome from '@/components/dashboard/founder-home/FounderHome'
import { useWorkspace } from '@/lib/workspace-context'
import { useSearchParams } from 'next/navigation'
import FreightReviewInbox from '@/components/dashboard/freight/FreightReviewInbox'

// 2026-07-02: founders get one full-page view (FounderHome — its own
// workspaces list, stats, calendar, and conversations all in one
// layout, no slide-out panel). Owners retain HomeScreen, with the narrow
// freightReview query rendering the human approval surface added by #434.
export default function DashboardPage() {
  const { isFounder, isOwner, workspaceId } = useWorkspace()
  const searchParams = useSearchParams()
  const freightReview = isOwner && searchParams.get('freightReview') === '1'

  return (
    <div className="tc-content" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden' }}>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, minHeight: 0 }}>
        {isFounder ? <FounderHome /> : freightReview ? <FreightReviewInbox workspaceId={workspaceId} /> : <HomeScreen />}
      </main>
    </div>
  )
}
