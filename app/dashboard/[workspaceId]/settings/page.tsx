'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import SettingsNav, { type TabId } from '@/components/settings/SettingsNav'
import ProfilePanel from '@/components/settings/ProfilePanel'
import ChannelsPanel from '@/components/settings/ChannelsPanel'
import CayeAIPanel from '@/components/settings/CayeAIPanel'
import CayeHealthPanel from '@/components/settings/CayeHealthPanel'
import NotificationsPanel from '@/components/settings/NotificationsPanel'
import WhatsAppPanel from '@/components/settings/WhatsAppPanel'
import TeamPanel from '@/components/settings/TeamPanel'
import BillingPanel from '@/components/settings/BillingPanel'
import ServicesPanel from '@/components/settings/ServicesPanel'
import { useDashboard } from '@/lib/dashboard-context'

const VALID_TABS = new Set<TabId>(['general', 'caye', 'workspace', 'billing'])

const SearchIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="5" /><path d="m13 13 3 3" />
  </svg>
)

const TAB_LABELS: Record<TabId, string> = {
  general: 'General',
  caye: 'Caye AI',
  workspace: 'Workspace',
  billing: 'Billing',
}

export default function SettingsPage() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const tabParam = searchParams.get('tab') as TabId | null
  const [active, setActiveState] = useState<TabId>(
    tabParam && VALID_TABS.has(tabParam) ? tabParam : 'general'
  )

  const { panelOpen, setPanelOpen } = useDashboard()
  const mainRef = useRef<HTMLDivElement>(null)

  const setActive = useCallback((tab: TabId) => {
    setActiveState(tab)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tab)
    router.replace(`?${params.toString()}`)
  }, [router, searchParams])

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [active])

  return (
    <div className="settings-layout">
      <header className="top-bar">
        <div className="tb-left">
          <nav className="breadcrumb">
            <span>Workspace</span>
            <span className="sep">/</span>
            <span>Settings</span>
            <span className="sep">/</span>
            <span className="here">{TAB_LABELS[active]}</span>
          </nav>
        </div>
        <div className="tb-right">
          <div className="tb-search">
            <SearchIcon />
            <input placeholder="Search settings…" />
          </div>
        </div>
      </header>

      <main className="tc-content">
        <div className="settings-screen">
          <SettingsNav active={active} setActive={setActive} />
          <div className="set-main" ref={mainRef}>
            {active === 'general' && (
              <>
                <ProfilePanel />
                <ChannelsPanel />
              </>
            )}
            {active === 'caye' && (
              <>
                <CayeAIPanel />
                <WhatsAppPanel />
                <CayeHealthPanel />
              </>
            )}
            {active === 'workspace' && (
              <>
                <ServicesPanel />
                <TeamPanel />
                <NotificationsPanel />
              </>
            )}
            {active === 'billing' && (
              <BillingPanel />
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
