'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import Avatar from '@/components/ui/Avatar'
import { useDashboard } from '@/lib/dashboard-context'
import { useWorkspace } from '@/lib/workspace-context'
import type { Screen } from '@/lib/types'

const SCREENS = [
  { id: 'chats' as Screen, label: 'Chats', count: null, icon: 'chat' },
  { id: 'contacts' as Screen, label: 'Contacts', count: null, icon: 'contacts' },
  { id: 'calendar' as Screen, label: 'Calendar', count: null, icon: 'cal' },
]

const NavIcon = ({ name, size = 18 }: { name: string; size?: number }) => {
  const s = size
  const st = {
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'chat':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M3 5.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8.5L5 16.5v-3H5a2 2 0 0 1-2-2v-6z" /></svg>
    case 'contacts':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><circle cx="10" cy="7.5" r="3" /><path d="M3.5 16.5c.6-3 3.2-4.5 6.5-4.5s5.9 1.5 6.5 4.5" /></svg>
    case 'cal':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><rect x="3" y="4.5" width="14" height="12" rx="2" /><path d="M3 8h14M7 3v3M13 3v3" /></svg>
    case 'settings':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M8.2 2.5h3.6l.5 2a5.7 5.7 0 0 1 1.6.9l1.9-.8 1.8 3-1.5 1.4a5.8 5.8 0 0 1 0 1.9l1.5 1.4-1.8 3-1.9-.8a5.7 5.7 0 0 1-1.6.9l-.5 2H8.2l-.5-2a5.7 5.7 0 0 1-1.6-.9l-1.9.8-1.8-3 1.5-1.4a5.8 5.8 0 0 1 0-1.9L2.4 8.6l1.8-3 1.9.8a5.7 5.7 0 0 1 1.6-.9l.5-2z" /><circle cx="10" cy="10" r="2.5" /></svg>
    case 'check':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="m5 10.5 3 3 7-7" /></svg>
    case 'chevron':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M5 8l5 4 5-4" /></svg>
    default:
      return null
  }
}

interface WorkspaceSwitcherProps {
  workspaces: ReturnType<typeof useWorkspace>['workspaces']
  currentId: string
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onSelect: (id: string) => void
  onClose: () => void
}

function WorkspaceSwitcher({ workspaces, currentId, anchorRef, onSelect, onClose }: WorkspaceSwitcherProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect()
      setPos({
        bottom: window.innerHeight - r.bottom,
        left: r.right + 8,
      })
    }
  }, [anchorRef])

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        bottom: pos.bottom,
        left: pos.left,
        zIndex: 9999,
        width: 240,
        background: '#101d26',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 14,
        boxShadow: '0 16px 48px -8px rgba(0,0,0,0.55), 0 4px 12px -4px rgba(0,0,0,0.3)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '10px 14px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <p style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.3)',
          margin: 0,
        }}>
          Switch workspace
        </p>
      </div>

      {/* Workspace list */}
      <div style={{ padding: '6px 6px' }}>
        {workspaces.map((m) => {
          const isActive = m.workspace_id === currentId
          const name = m.customer.business_name || 'Unnamed workspace'
          return (
            <button
              key={m.workspace_id}
              onClick={() => onSelect(m.workspace_id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '7px 9px',
                borderRadius: 9,
                background: isActive ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: isActive ? '#fff' : 'rgba(255,255,255,0.6)',
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                textAlign: 'left',
                transition: 'background 0.12s ease',
                cursor: 'pointer',
              }}
              onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              {m.customer.avatar_url ? (
                <img
                  src={m.customer.avatar_url}
                  alt={name}
                  style={{ width: 26, height: 26, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <Avatar name={name} size={26} />
              )}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </span>
              {isActive && (
                <span style={{ flexShrink: 0, opacity: 0.7 }}>
                  <NavIcon name="check" size={14} />
                </span>
              )}
              {!isActive && (
                <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'rgba(255,255,255,0.3)', flexShrink: 0, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {m.role}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>,
    document.body
  )
}

interface SidebarProps {
  workspaceId: string
}

export default function Sidebar({ workspaceId }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { screen, setScreen, sidebarExpanded, setSidebarExpanded } = useDashboard()
  const { workspace, workspaces } = useWorkspace()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const userButtonRef = useRef<HTMLButtonElement>(null)

  const isSettings = pathname?.includes('/settings') ?? false
  const bizName = workspace?.business_name || 'My Workspace'
  const bizWords = bizName.trim().split(' ')
  const shortName = bizWords[0] + (bizWords[1] ? ' ' + bizWords[1][0] + '.' : '')
  const timezone = workspace?.timezone
    ? workspace.timezone.split('/')[1]?.replace(/_/g, ' ').toLowerCase() || workspace.timezone
    : ''

  const handleScreenClick = (s: Screen) => {
    setScreen(s)
  }

  const handleSelectWorkspace = useCallback((id: string) => {
    setSwitcherOpen(false)
    if (id !== workspaceId) {
      localStorage.setItem('lastActiveWorkspaceId', id)
      router.push(`/dashboard/${id}`)
    }
  }, [workspaceId, router])

  const hasMultiple = workspaces.length > 1

  return (
    <>
      <nav
        className={'sidebar' + (sidebarExpanded ? ' expanded' : '')}
        onMouseEnter={() => setSidebarExpanded(true)}
        onMouseLeave={() => setSidebarExpanded(false)}
      >
        <div className="sb-top">
          <Link href={`/dashboard/${workspaceId}`} className="sb-brand">
            <span className="sb-mark">C</span>
            <span className="sb-brand-name">Caye</span>
          </Link>

          <div className="sb-section">
            <span className="sb-section-label">Workspace</span>
            {SCREENS.map((s) => (
              <button
                key={s.id}
                className={'sb-item' + (!isSettings && screen === s.id ? ' active' : '')}
                onClick={() => handleScreenClick(s.id)}
                title={s.label}
              >
                <span className="sb-icon"><NavIcon name={s.icon} size={18} /></span>
                <span className="sb-label">{s.label}</span>
                {s.count != null && <span className="sb-count">{s.count}</span>}
              </button>
            ))}
          </div>

        </div>

        <div className="sb-bottom">
          <Link
            href={`/dashboard/${workspaceId}/settings`}
            className={'sb-item' + (isSettings ? ' active' : '')}
            title="Settings"
          >
            <span className="sb-icon"><NavIcon name="settings" size={18} /></span>
            <span className="sb-label">Settings</span>
          </Link>

          <button
            ref={userButtonRef}
            className={'sb-item sb-user' + (switcherOpen ? ' active' : '')}
            title={hasMultiple ? `${bizName} — click to switch` : bizName}
            onClick={() => hasMultiple && setSwitcherOpen(v => !v)}
            style={{ cursor: hasMultiple ? 'pointer' : 'default' }}
          >
            <Avatar name={bizName} size={26} />
            <span className="sb-label">
              <span className="sb-user-name" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {shortName}
                {hasMultiple && (
                  <span style={{ opacity: 0.4, marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                    <NavIcon name="chevron" size={12} />
                  </span>
                )}
              </span>
              {timezone && <span className="sb-user-org">{timezone}</span>}
            </span>
          </button>
        </div>
      </nav>

      {switcherOpen && (
        <WorkspaceSwitcher
          workspaces={workspaces}
          currentId={workspaceId}
          anchorRef={userButtonRef}
          onSelect={handleSelectWorkspace}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </>
  )
}
