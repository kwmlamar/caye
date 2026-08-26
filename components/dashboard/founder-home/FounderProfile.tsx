'use client'

import { useState, useRef, useEffect } from 'react'
import { useFounderIdentity } from '@/lib/useFounderIdentity'
import { signOut } from '@/lib/supabase'
import { sidebarPopoverSurface, paneShadowSoft, TEXT_QUIET } from '../surface'

const SETTINGS_ICON = (
  <><line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" />
    <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" />
    <line x1="4" y1="18" x2="20" y2="18" /><circle cx="9" cy="18" r="2" /></>
)
const SIGN_OUT_ICON = <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>

/**
 * Bottom-of-sidebar account row — name + avatar, opens a small menu
 * upward (Settings, Sign out) instead of the old single-purpose "click
 * the initial to sign out" button. Settings used to be its own nav rail
 * icon; folding it in here (mirroring the Claude app's own bottom-left
 * account row) means the rail only ever lists destinations Caye actually
 * does work in, not account chrome.
 */
export default function FounderProfile({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { firstName, email } = useFounderIdentity()
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const label = firstName ?? email ?? 'Founder'
  const initial = label.slice(0, 1).toUpperCase()

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 100,
            width: 200, borderRadius: 14, padding: 5,
            ...sidebarPopoverSurface(),
            boxShadow: paneShadowSoft,
            animation: 'caye-popover-in 0.16s ease-out',
          }}
        >
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onOpenSettings() }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '8px 9px',
              border: 0, borderRadius: 9, background: 'transparent', color: '#e4e4e7',
              cursor: 'pointer', textAlign: 'left', font: '500 12.5px inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{SETTINGS_ICON}</svg>
            Settings
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); signOut() }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '8px 9px',
              border: 0, borderRadius: 9, background: 'transparent', color: '#e4e4e7',
              cursor: 'pointer', textAlign: 'left', font: '500 12.5px inherit',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{SIGN_OUT_ICON}</svg>
            Sign out
          </button>
        </div>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email ?? undefined}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
          border: 0, borderRadius: 10, cursor: 'pointer',
          background: hover || open ? 'rgba(255,255,255,0.045)' : 'transparent',
          transition: 'background 0.14s ease',
        }}
      >
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          width: 26, height: 26, borderRadius: '50%',
          background: 'rgba(78,190,206,0.14)', color: '#4EBECE',
          fontSize: 11.5, fontWeight: 700,
        }}>
          {initial}
        </span>
        <span style={{
          flex: 1, minWidth: 0, textAlign: 'left', fontSize: 12.5, fontWeight: 500, color: '#e4e4e7',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={TEXT_QUIET} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </div>
  )
}
