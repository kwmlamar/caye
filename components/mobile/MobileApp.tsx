'use client'

import { useCallback, useEffect, useState } from 'react'
import { useWorkspace } from '@/lib/workspace-context'
import { getHeldConversations } from '@/lib/data/mobile'
import MIcon, { type MIconName } from './MIcon'
import HomeScreen from './screens/HomeScreen'
import BookingsScreen from './screens/BookingsScreen'
import HeldScreen from './screens/HeldScreen'
import ActivityScreen from './screens/ActivityScreen'
import RulesScreen from './screens/RulesScreen'

export type MobileTab = 'home' | 'bookings' | 'held' | 'activity' | 'settings'

const TABS: { id: MobileTab; label: string; icon: MIconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'bookings', label: 'Bookings', icon: 'cal' },
  { id: 'held', label: 'Held', icon: 'alert' },
  { id: 'activity', label: 'Activity', icon: 'feed' },
  { id: 'settings', label: 'Caye', icon: 'spark' },
]

export default function MobileApp() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<MobileTab>('home')
  const [heldCount, setHeldCount] = useState(0)

  const refreshHeld = useCallback(async () => {
    try {
      const held = await getHeldConversations(workspaceId)
      setHeldCount(held.length)
    } catch {
      /* leave previous count */
    }
  }, [workspaceId])

  useEffect(() => {
    refreshHeld()
  }, [refreshHeld])

  return (
    <div className="mobile-root">
      {tab === 'home' && <HomeScreen onTabChange={setTab} onHeldChange={refreshHeld} />}
      {tab === 'bookings' && <BookingsScreen />}
      {tab === 'held' && <HeldScreen onResolved={refreshHeld} />}
      {tab === 'activity' && <ActivityScreen />}
      {tab === 'settings' && <RulesScreen />}

      <nav className="tab-nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={'tab-btn' + (tab === t.id ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            <span className="icon-wrap">
              <MIcon name={t.icon} size={22} />
              {t.id === 'held' && heldCount > 0 && <span className="tab-badge">{heldCount}</span>}
            </span>
            <span className="lbl">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
