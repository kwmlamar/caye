'use client'

import { useState, useRef, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { FounderRailId } from '@/lib/types'
import type { WorkspaceMembership } from '@/lib/workspace-context'
import type { CustomerStatus } from '@/types/database'
import FounderProfile from './FounderProfile'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import { AQUA, TEXT_QUIET, glass, sidebarPopoverSurface, paneShadowSoft } from '../surface'

export type ActiveView =
  | { type: 'page'; id: FounderRailId }
  | { type: 'thread'; id: string }
  | { type: 'operator'; id: number }

export interface ThreadListItem {
  id: string
  title: string | null
  status: 'active' | 'archived'
  last_activity_at: string
  created_by: 'founder' | 'caye'
  pinned_at: string | null
}

export interface LiveOperator {
  id: number
  name: string | null
  role: 'owner' | 'staff' | 'founder'
}

const PRIMARY_NAV_ITEMS: { id: FounderRailId; label: string; icon: ReactNode }[] = [
  { id: 'inbox', label: 'Inbox', icon: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></> },
  { id: 'work', label: 'Work', icon: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></> },
  { id: 'direction', label: 'Direction', icon: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" /></> },
]

const SECONDARY_NAV_ITEMS: { id: FounderRailId; label: string; icon: ReactNode }[] = [
  { id: 'people', label: 'People', icon: <><circle cx="9" cy="8" r="3" /><path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6" /><circle cx="17" cy="8" r="2.5" /><path d="M17 13.5c2.5.3 4 2.3 4 5.5" /></> },
  { id: 'memory', label: 'Memory', icon: <><path d="M12 4.5c-2-1.6-5-1.6-7 0v13c2-1.6 5-1.6 7 0" /><path d="M12 4.5c2-1.6 5-1.6 7 0v13c-2-1.6-5-1.6-7 0" /></> },
]

const TOGGLE_ICON = <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M9 3v18" /></>
const NEW_CHAT_ICON = <path d="M12 5v14M5 12h14" />
const MORE_DOTS_ICON = <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>
const THREAD_MORE_ICON = <><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></>
const PIN_ICON = <><path d="M12 2 9.5 9 4 11l6 3 1 7 1-7 6-3-5.5-2z" /></>
const UNPIN_ICON = <><path d="M12 2 9.5 9 4 11l6 3 1 7 1-7 6-3-5.5-2z" /><line x1="3" y1="3" x2="21" y2="21" /></>
const RENAME_ICON = <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>
const ARCHIVE_ICON = <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>
const DELETE_ICON = <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" /></>

function Icon({ path, size = 16, stroke = 'currentColor' }: { path: ReactNode; size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {path}
    </svg>
  )
}

function ThreadRowMenu({
  anchorEl, pinned, onRename, onTogglePin, onArchive, onDelete, onClose,
}: {
  anchorEl: HTMLElement
  pinned: boolean
  onRename: () => void
  onTogglePin: () => void
  onArchive: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEffect(() => {
    const menuWidth = 176
    const gap = 8
    const viewportPadding = 8

    function updatePosition() {
      const anchor = anchorEl.getBoundingClientRect()
      const menuHeight = rootRef.current?.offsetHeight ?? 138
      const preferredLeft = anchor.right + gap
      const left = Math.min(preferredLeft, window.innerWidth - menuWidth - viewportPadding)
      const belowTop = anchor.bottom + 4
      const top = belowTop + menuHeight <= window.innerHeight - viewportPadding
        ? belowTop
        : Math.max(viewportPadding, anchor.top - menuHeight - 4)

      setPosition({
        top,
        left: Math.max(viewportPadding, left),
      })
    }

    function onDocClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        rootRef.current &&
        !rootRef.current.contains(target) &&
        !anchorEl.contains(target)
      ) onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }

    updatePosition()
    const frame = requestAnimationFrame(updatePosition)
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorEl, onClose])

  const items: { label: string; icon: ReactNode; onClick: () => void; danger?: boolean }[] = [
    { label: 'Rename', icon: RENAME_ICON, onClick: onRename },
    { label: pinned ? 'Unpin chat' : 'Pin chat', icon: pinned ? UNPIN_ICON : PIN_ICON, onClick: onTogglePin },
    { label: 'Archive', icon: ARCHIVE_ICON, onClick: onArchive },
    { label: 'Delete', icon: DELETE_ICON, onClick: onDelete, danger: true },
  ]

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      className="cs-thread-menu"
      style={{
        position: 'fixed', top: position.top, left: position.left, zIndex: 10000,
        width: 176, borderRadius: 12, padding: 5,
        ...sidebarPopoverSurface(), boxShadow: paneShadowSoft,
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={(e) => { e.stopPropagation(); item.onClick() }}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '7px 9px',
            border: 0, borderRadius: 8, background: 'transparent',
            color: item.danger ? '#f87171' : '#e4e4e7', cursor: 'pointer',
            textAlign: 'left', font: '500 12px inherit',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? 'rgba(248,113,113,0.1)' : 'rgba(255,255,255,0.05)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <Icon path={item.icon} size={13} />
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}

function ToggleButton({ collapsed, onToggle, floating }: { collapsed: boolean; onToggle: () => void; floating: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onToggle}
      title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...(floating ? { position: 'absolute', top: 14, left: 14, zIndex: 30 } : { flexShrink: 0 }),
        width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 0, borderRadius: 8, cursor: 'pointer',
        background: hover ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: hover ? '#f4f4f5' : '#8f8f97',
        transition: 'background 0.14s ease, color 0.14s ease',
      }}
    >
      <Icon path={TOGGLE_ICON} size={15} />
    </button>
  )
}

function NavRow({ label, icon, active, onClick, trailing }: {
  label: string
  icon: ReactNode
  active: boolean
  onClick: () => void
  trailing?: ReactNode
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={active ? 'page' : undefined}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '6px 9px',
        border: 0, borderRadius: 9, textAlign: 'left', cursor: 'pointer',
        background: active ? 'rgba(78,190,206,0.1)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        color: active ? '#7DD8E0' : hover ? '#e4e4e7' : '#9c9ca3',
        transition: 'background 0.14s ease, color 0.14s ease',
      }}
    >
      <Icon path={icon} size={15} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500 }}>{label}</span>
      {trailing}
    </button>
  )
}

function SectionLabel({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div style={{
      padding: compact ? '9px 8px 4px' : '12px 8px 5px',
      color: '#5c5c64', fontSize: 10, fontWeight: 600, letterSpacing: '0.025em',
    }}>
      {children}
    </div>
  )
}

function livePriority(operator: LiveOperator): number {
  const name = operator.name?.trim().toLowerCase()
  if (name === 'mrs. max' || name === 'mrs max') return 0
  if (name === 'max') return 1
  return 2
}

export default function CommandSidebar({
  collapsed, onToggleCollapsed,
  activeView, onSelectPage,
  threads, onSelectThread, onNewThread, creatingThread,
  onRenameThread, onTogglePinThread, onArchiveThread, onDeleteThread,
  operators, onSelectOperator,
  businessName, workspaceStatus, workspaces, activeWorkspaceId, onSelectWorkspace, hasActivity,
}: {
  collapsed: boolean
  onToggleCollapsed: () => void
  activeView: ActiveView
  onSelectPage: (id: FounderRailId) => void
  threads: ThreadListItem[] | null
  onSelectThread: (id: string) => void
  onNewThread: () => void
  creatingThread: boolean
  onRenameThread: (id: string, title: string) => void
  onTogglePinThread: (id: string, pinned: boolean) => void
  onArchiveThread: (id: string) => void
  onDeleteThread: (id: string) => void
  operators: LiveOperator[] | null
  onSelectOperator: (id: number) => void
  businessName: string
  workspaceStatus: CustomerStatus
  workspaces: WorkspaceMembership[]
  activeWorkspaceId: string
  onSelectWorkspace: (workspaceId: string) => void
  hasActivity: (workspaceId: string) => boolean
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const secondaryActive = activeView.type === 'page' && SECONDARY_NAV_ITEMS.some((item) => item.id === activeView.id)

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  useEffect(() => {
    if (secondaryActive) setMoreOpen(true)
  }, [secondaryActive])

  function closeThreadMenu() {
    setOpenMenuId(null)
    setMenuAnchor(null)
  }

  function startRename(thread: ThreadListItem) {
    setRenamingId(thread.id)
    setRenameValue(thread.title || '')
    closeThreadMenu()
  }

  function commitRename() {
    if (!renamingId) return
    const trimmed = renameValue.trim()
    if (trimmed) onRenameThread(renamingId, trimmed)
    setRenamingId(null)
  }

  const pinnedThreads = (threads ?? [])
    .filter((thread) => thread.pinned_at)
    .sort((a, b) => new Date(b.pinned_at as string).getTime() - new Date(a.pinned_at as string).getTime())
  const recentThreads = (threads ?? [])
    .filter((thread) => !thread.pinned_at)
    .sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime())
  const sortedOperators = (operators ?? [])
    .slice()
    .sort((a, b) => livePriority(a) - livePriority(b) || (a.name || '').localeCompare(b.name || ''))

  function renderThreadRow(thread: ThreadListItem) {
    const active = activeView.type === 'thread' && activeView.id === thread.id
    const menuOpen = openMenuId === thread.id

    if (renamingId === thread.id) {
      return (
        <div key={thread.id} style={{ padding: '2px 8px' }}>
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              if (e.key === 'Escape') setRenamingId(null)
            }}
            style={{
              width: '100%', padding: '5px 7px', border: `1px solid ${AQUA}55`, borderRadius: 7,
              background: 'rgba(255,255,255,0.05)', color: '#f4f4f5', font: '500 12px inherit', outline: 'none',
            }}
          />
        </div>
      )
    }

    return (
      <div key={thread.id} className={`cs-thread-row ${menuOpen ? 'is-menu-open' : ''}`} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => onSelectThread(thread.id)}
          style={{
            position: 'relative', flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6,
            padding: '5.5px 26px 5.5px 8px', overflow: 'hidden', border: 0, borderRadius: 8,
            background: active ? 'rgba(78,190,206,0.11)' : 'transparent',
            color: active ? '#f4f4f5' : '#b1b1b9', cursor: 'pointer', textAlign: 'left',
            font: '500 12px inherit', whiteSpace: 'nowrap',
          }}
        >
          {thread.created_by === 'caye' && (
            <span aria-label="Started by Caye" style={{ width: 5, height: 5, flex: '0 0 5px', borderRadius: '50%', background: AQUA }} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{thread.title || 'New conversation'}</span>
        </button>
        <button
          type="button"
          className="cs-thread-more"
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation()
            if (menuOpen) {
              closeThreadMenu()
            } else {
              setOpenMenuId(thread.id)
              setMenuAnchor(e.currentTarget)
            }
          }}
          style={{
            position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
            width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 0, borderRadius: 6, cursor: 'pointer',
            background: menuOpen ? 'rgba(255,255,255,0.09)' : 'transparent',
            color: menuOpen ? '#f4f4f5' : '#9c9ca3',
          }}
        >
          <Icon path={THREAD_MORE_ICON} size={13} />
        </button>
        {menuOpen && menuAnchor && (
          <ThreadRowMenu
            anchorEl={menuAnchor}
            pinned={!!thread.pinned_at}
            onRename={() => startRename(thread)}
            onTogglePin={() => { onTogglePinThread(thread.id, !thread.pinned_at); closeThreadMenu() }}
            onArchive={() => { onArchiveThread(thread.id); closeThreadMenu() }}
            onDelete={() => {
              closeThreadMenu()
              if (window.confirm(`Delete "${thread.title || 'New conversation'}"? This can't be undone.`)) onDeleteThread(thread.id)
            }}
            onClose={closeThreadMenu}
          />
        )}
      </div>
    )
  }

  return (
    <>
      <style>{`
        @keyframes cs-thread-menu-in { from { opacity:0; transform:translateY(-4px) scale(.97); } to { opacity:1; transform:translateY(0) scale(1); } }
        .cs-thread-menu { animation: cs-thread-menu-in 0.12s ease-out; }
        .cs-thread-more { opacity: 0; pointer-events: none; transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease; }
        .cs-thread-row:hover .cs-thread-more, .cs-thread-row.is-menu-open .cs-thread-more { opacity: 1; pointer-events: auto; }
        @media (prefers-reduced-motion: reduce) { .cs-thread-menu { animation: none; } }
      `}</style>

      {collapsed && <ToggleButton collapsed={collapsed} onToggle={onToggleCollapsed} floating />}

      <nav
        aria-label="Caye Command navigation"
        style={{
          width: collapsed ? 0 : 228, flexShrink: 0, overflow: 'hidden',
          display: 'flex', flexDirection: 'column', background: 'rgba(15,15,17,0.4)',
          marginRight: collapsed ? 0 : 10,
          transition: 'width 0.18s cubic-bezier(.2,.8,.2,1), margin-right 0.18s cubic-bezier(.2,.8,.2,1)',
          ...glass(0.02),
        }}
      >
        <div style={{ width: 228, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 7px 4px', flexShrink: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <WorkspaceSwitcher
                businessName={businessName}
                status={workspaceStatus}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                onSelect={onSelectWorkspace}
                hasActivity={hasActivity}
                menuWidth={200}
              />
            </div>
            <ToggleButton collapsed={collapsed} onToggle={onToggleCollapsed} floating={false} />
          </div>

          <div style={{ padding: '3px 9px 0', flexShrink: 0 }}>
            <button
              type="button"
              onClick={onNewThread}
              disabled={creatingThread}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 9px',
                border: 0, borderRadius: 9, background: 'transparent', color: '#d4d4d8',
                cursor: creatingThread ? 'default' : 'pointer', textAlign: 'left', font: '550 12.5px inherit',
                opacity: creatingThread ? 0.6 : 1,
              }}
              onMouseEnter={(e) => { if (!creatingThread) e.currentTarget.style.background = 'rgba(255,255,255,0.045)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <Icon path={NEW_CHAT_ICON} size={14} stroke={AQUA} />
              New conversation
            </button>
          </div>

          <div style={{ padding: '7px 9px 2px', display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
            {PRIMARY_NAV_ITEMS.map((item) => (
              <NavRow
                key={item.id}
                label={item.label}
                icon={item.icon}
                active={activeView.type === 'page' && activeView.id === item.id}
                onClick={() => onSelectPage(item.id)}
              />
            ))}
            <NavRow
              label="More"
              icon={MORE_DOTS_ICON}
              active={secondaryActive}
              onClick={() => setMoreOpen((current) => !current)}
            />
            {moreOpen && (
              <div style={{ padding: '1px 0 2px 12px' }}>
                {SECONDARY_NAV_ITEMS.map((item) => (
                  <NavRow
                    key={item.id}
                    label={item.label}
                    icon={item.icon}
                    active={activeView.type === 'page' && activeView.id === item.id}
                    onClick={() => onSelectPage(item.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 7px' }}>
            {sortedOperators.length > 0 && (
              <div>
                <SectionLabel>Team</SectionLabel>
                {sortedOperators.map((operator) => {
                  const active = activeView.type === 'operator' && activeView.id === operator.id
                  return (
                    <button
                      key={operator.id}
                      type="button"
                      onClick={() => onSelectOperator(operator.id)}
                      style={{
                        position: 'relative', width: '100%', display: 'flex', alignItems: 'center', gap: 7,
                        padding: '5.5px 8px', overflow: 'hidden', border: 0, borderRadius: 8,
                        background: active ? 'rgba(78,190,206,0.11)' : 'transparent',
                        color: active ? '#f4f4f5' : '#b1b1b9', cursor: 'pointer', textAlign: 'left',
                        font: '500 12px inherit', whiteSpace: 'nowrap',
                      }}
                    >
                      <span aria-hidden style={{ width: 6, height: 6, flex: '0 0 6px', borderRadius: '50%', background: '#34d399', boxShadow: '0 0 6px rgba(52,211,153,0.6)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{operator.name || 'Operator'}</span>
                      <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 9, color: '#5c5c64' }}>live</span>
                    </button>
                  )
                })}
              </div>
            )}

            {pinnedThreads.length > 0 && (
              <div>
                <SectionLabel compact>Pinned</SectionLabel>
                {pinnedThreads.map((thread) => renderThreadRow(thread))}
              </div>
            )}

            <SectionLabel compact>Recent</SectionLabel>
            {threads === null ? (
              <div style={{ padding: '6px 8px', color: TEXT_QUIET, fontSize: 11 }}>Loading…</div>
            ) : recentThreads.length === 0 ? (
              <div style={{ padding: '6px 8px', color: TEXT_QUIET, fontSize: 11 }}>No conversations yet.</div>
            ) : (
              recentThreads.map((thread) => renderThreadRow(thread))
            )}
          </div>

          <div style={{ padding: '6px 9px 9px', flexShrink: 0 }}>
            <FounderProfile onOpenSettings={() => onSelectPage('settings')} />
          </div>
        </div>
      </nav>
    </>
  )
}
