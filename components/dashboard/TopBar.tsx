import type { Screen } from '@/lib/types'

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
      </div>
    </header>
  )
}
