'use client'

import type { Screen } from '@/lib/types'
import { useDashboard } from '@/lib/dashboard-context'

const SearchIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="5" />
    <path d="m13 13 3 3" />
  </svg>
)

const TITLE_MAP: Record<Screen, string> = {
  chats: 'Chats',
  contacts: 'Contacts',
  calendar: 'Calendar',
}

export default function TopBar({ screen }: { screen: Screen }) {
  const { cayeOpen, setCayeOpen } = useDashboard()

  return (
    <header className="top-bar">
      <div className="tb-left">
        <h1 className="tb-title">{TITLE_MAP[screen]}</h1>
      </div>
      <div className="tb-right">
        <div className="tb-search">
          <SearchIcon />
          <input placeholder="Search everything…" />
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
  )
}
