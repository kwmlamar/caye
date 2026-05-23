'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import SettingsNav from '@/components/settings/SettingsNav'
import ProfilePanel from '@/components/settings/ProfilePanel'
import ChannelsPanel from '@/components/settings/ChannelsPanel'
import CayeAIPanel from '@/components/settings/CayeAIPanel'
import NotificationsPanel from '@/components/settings/NotificationsPanel'
import TeamPanel from '@/components/settings/TeamPanel'
import BillingPanel from '@/components/settings/BillingPanel'
import ServicesPanel from '@/components/settings/ServicesPanel'
import { useDashboard } from '@/lib/dashboard-context'
import type { SettingsSection } from '@/lib/types'

const VALID_SECTIONS = new Set<SettingsSection>(['profile', 'channels', 'caye', 'notifications', 'team', 'billing', 'services'])

const SearchIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="5" /><path d="m13 13 3 3" />
  </svg>
)

const SECTION_LABELS: Record<SettingsSection, string> = {
  profile: 'Profile',
  channels: 'Channels',
  caye: 'Caye AI',
  services: 'Services',
  notifications: 'Notifications',
  team: 'Team',
  billing: 'Billing',
}

export default function SettingsPage() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const tabParam = searchParams.get('tab') as SettingsSection | null
  const [active, setActiveState] = useState<SettingsSection>(
    tabParam && VALID_SECTIONS.has(tabParam) ? tabParam : 'caye'
  )

  const { cayeOpen, setCayeOpen } = useDashboard()
  const mainRef = useRef<HTMLDivElement>(null)

  const setActive = useCallback((section: SettingsSection) => {
    setActiveState(section)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', section)
    router.replace(`?${params.toString()}`)
  }, [router, searchParams])

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [active])

  return (
    <>
      <header className="top-bar">
        <div className="tb-left">
          <nav className="breadcrumb">
            <span>Workspace</span>
            <span className="sep">/</span>
            <span>Settings</span>
            <span className="sep">/</span>
            <span className="here">{SECTION_LABELS[active]}</span>
          </nav>
        </div>
        <div className="tb-right">
          <div className="tb-search">
            <SearchIcon />
            <input placeholder="Search settings…" />
          </div>
          <button
            className={`tb-caye${cayeOpen ? ' on' : ''}`}
            onClick={() => setCayeOpen(v => !v)}
          >
            <span className="caye-dot" style={{ width: 8, height: 8 }}></span>
            {cayeOpen ? 'Caye is on' : 'Ask Caye'}
            <span className="kbd">⌘J</span>
          </button>
        </div>
      </header>

      <main className="tc-content">
        <div className="settings-screen">
          <SettingsNav active={active} setActive={setActive} />
          <div className="set-main" ref={mainRef}>
            {active === 'profile'       && <ProfilePanel />}
            {active === 'channels'      && <ChannelsPanel />}
            {active === 'caye'          && <CayeAIPanel />}
            {active === 'notifications' && <NotificationsPanel />}
            {active === 'team'          && <TeamPanel />}
            {active === 'billing'       && <BillingPanel />}
            {active === 'services'     && <ServicesPanel />}
          </div>
        </div>
      </main>
    </>
  )
}
