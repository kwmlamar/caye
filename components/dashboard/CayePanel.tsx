'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useDashboard } from '@/lib/dashboard-context'
import type { Screen } from '@/lib/types'
import ChatsScreen from '@/components/dashboard/chats/ChatsScreen'
import BookingsScreen from '@/components/dashboard/bookings/BookingsScreen'
import CalendarScreen from '@/components/dashboard/calendar/CalendarScreen'
import ContactsScreen from '@/components/dashboard/contacts/ContactsScreen'
import CommandScreen from '@/components/dashboard/command/CommandScreen'
import { CayeMark } from '@/components/brand/CayeMark'

const MIN_WIDTH = 420
const MAX_WIDTH = 800
const DEFAULT_WIDTH = 480

export default function CayePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { panelScreen, setPanelScreen, isPanelDetail, setIsPanelDetail } = useDashboard()

  const tabs: { id: Screen; label: string }[] = [
    { id: 'chats', label: 'inbox' },
    { id: 'bookings', label: 'bookings' },
    { id: 'calendar', label: 'calendar' },
    { id: 'contacts', label: 'contacts' },
    { id: 'command', label: 'command' },
  ]

  return (
    <aside 
      className={'caye-panel' + (open ? ' open' : '')} 
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      {/* Header — dark, minimal: mark + tabs + close. No banners, no
          decorative chrome. */}
      <header className="cp-head flex-shrink-0" style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 12 }}>
          <CayeMark size={22} />

          {isPanelDetail ? (
            <button onClick={() => setIsPanelDetail(false)} className="cp-back" style={{ flex: 1 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              back
            </button>
          ) : (
            <div className="cp-tabs" style={{ flex: 1 }}>
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setPanelScreen(tab.id)}
                  className={`cp-tab${panelScreen === tab.id ? ' active' : ''}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          <button className="cp-close" onClick={onClose} aria-label="Close panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </header>

      {/* Screen Content Wrapper */}
      <div className="flex-1 overflow-hidden" style={{ display: 'flex', flexDirection: 'column' }}>
        {panelScreen === 'chats' && <ChatsScreen openCaye={() => {}} inPanel={true} />}
        {panelScreen === 'bookings' && <BookingsScreen inPanel={true} />}
        {panelScreen === 'calendar' && <CalendarScreen inPanel={true} />}
        {panelScreen === 'contacts' && <ContactsScreen inPanel={true} />}
        {panelScreen === 'command' && <CommandScreen />}
      </div>
    </aside>
  )
}
