'use client'

import type { Screen } from '@/lib/types'
import { useDashboard } from '@/lib/dashboard-context'

const SearchIcon = () => (
  <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="9" r="5" />
    <path d="m13 13 3 3" />
  </svg>
)

const CayeToggleIcon = ({ active }: { active: boolean }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="2" width="12" height="12" rx="2" />
    <path d="M9 2v12" />
    <path
      d="M9 2h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9V2z"
      fill="currentColor"
      fillOpacity={active ? 0.35 : 0}
      stroke="none"
      style={{ transition: 'fill-opacity 0.2s ease' }}
    />
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
          className={`tb-caye-toggle${cayeOpen ? ' active' : ''}`}
          onClick={() => setCayeOpen(!cayeOpen)}
          title="Toggle Caye Panel (⌘J)"
          aria-label="Toggle Caye Panel"
        >
          <CayeToggleIcon active={cayeOpen} />
        </button>
      </div>
    </header>
  )
}
