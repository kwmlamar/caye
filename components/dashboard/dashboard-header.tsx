"use client"

import { usePathname } from "next/navigation"
import { MagnifyingGlass } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

interface DashboardHeaderProps {
  onToggleCaye?: () => void
  cayePanelOpen?: boolean
}

export function DashboardHeader({ onToggleCaye, cayePanelOpen }: DashboardHeaderProps) {
  const pathname = usePathname()

  const getPageTitle = () => {
    if (pathname.includes("/contacts")) return "Contacts"
    if (pathname.includes("/calendar")) return "Calendar"
    if (pathname.includes("/ai")) return "Caye AI"
    if (pathname.includes("/settings")) return "Settings"
    return "Chats"
  }

  return (
    <div
      style={{
        height: '60px',
        minHeight: '60px',
        backgroundColor: 'var(--tc-bg-app)',
        borderBottom: '1px solid rgba(11,20,25,0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        position: 'relative',
        zIndex: 40,
        width: '100%'
      }}
    >
      <div className="flex items-center gap-4">
        <h1 className="text-[18px] font-bold text-[var(--tc-ink)] tracking-tight">
          {getPageTitle()}
        </h1>
      </div>

      <div className="flex items-center gap-3">
        {/* Global Search */}
        <div className="dash-search w-[280px]">
          <MagnifyingGlass className="h-[14px] w-[14px] text-[var(--tc-ink-mute)]" />
          <input
            type="text"
            placeholder="Search everything.."
            className="flex-1"
          />
        </div>

        {/* Caye panel toggle */}
        {onToggleCaye && (
          <button
            onClick={onToggleCaye}
            title={cayePanelOpen ? "Close Caye" : "Open Caye"}
            className={cn(
              "flex items-center justify-center w-8 h-8 rounded-lg transition-all duration-150 border",
              cayePanelOpen
                ? "bg-[var(--tc-teal-soft)] border-[var(--tc-teal)]/20 text-[var(--tc-teal)]"
                : "bg-transparent border-[var(--tc-line)] text-[var(--tc-ink-mute)] hover:bg-[var(--tc-bg-deep)] hover:text-[var(--tc-ink)]"
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="10" y1="2" x2="10" y2="14" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
