'use client'

import { useState, useRef, useEffect, type ReactNode } from 'react'
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

const NAV_ITEMS: { id: FounderRailId; label: string; icon: ReactNode }[] = [
  { id: 'inbox', label: 'Inbox', icon: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></> },
  { id: 'people', label: 'People', icon: (
    <><circle cx="9" cy="8" r="3" /><path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6" /><circle cx="17" cy="8" r="2.5" /><path d="M17 13.5c2.5.3 4 2.3 4 5.5" /></>
  ) },
  { id: 'work', label: 'Work', icon: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></> },
  { id: 'memory', label: 'Memory', icon: <><path d="M12 4.5c-2-1.6-5-1.6-7 0v13c2-1.6 5-1.6 7 0" /><path d="M12 4.5c2-1.6 5-1.6 7 0v13c-2-1.6-5-1.6-7 0" /></> },
  { id: 'direction', label: 'Direction', icon: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" /></> },
]

const TOGGLE_ICON = <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M9 3v18" /></>
const NEW_CHAT_ICON = <path d="M12 5v14M5 12h14" />
const MORE_ICON = <><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></>
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

/** ChatGPT-style per-chat "more" menu — Rename, Pin/Unpin, Archive, Delete.
 *  No Share item: Caye Direct threads are founder-only business history,
 *  not something meant to leave the dashboard. */
function ThreadRowMenu({
  pinned, onRename, onTogglePin, onArchive, onDelete, onClose,
}: {
  pinned: boolean
  onRename: () => void
  onTogglePin: () => void
  onArchive: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const items: { label: string; icon: ReactNode; onClick: () => void; danger?: boolean }[] = [
    { label: 'Rename', icon: RENAME_ICON, onClick: onRename },
    { label: pinned ? 'Unpin chat' : 'Pin chat', icon: pinned ? UNPIN_ICON : PIN_ICON, onClick: onTogglePin },
    { label: 'Archive', icon: ARCHIVE_ICON, onClick: onArchive },
    { label: 'Delete', icon: DELETE_ICON, onClick: onDelete, danger: true },
  ]

  return (
    <div
      ref={rootRef}
      role="menu"
      className="cs-thread-menu"
      style={{
        position: 'absolute', top: '100%', right: 4, zIndex: 100,
        width: 176, borderRadius: 12, padding: 5,
        ...sidebarPopoverSurface(),
        boxShadow: paneShadowSoft,
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
            color: item.danger ? '#f87171' : '#e4e4e7',
            cursor: 'pointer', textAlign: 'left', font: '500 12px inherit',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = item.danger ? 'rgba(248,113,113,0.1)' : 'rgba(255,255,255,0.05)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
        >
          <Icon path={item.icon} size={13} />
          {item.label}
        </button>
      ))}
    </div>
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
        width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 0, borderRadius: 9, cursor: 'pointer',
        background: hover ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: hover ? '#f4f4f5' : '#8f8f97',
        transition: 'background 0.14s ease, color 0.14s ease',
      }}
    >
      <Icon path={TOGGLE_ICON} />
    </button>
  )
}

function NavRow({ label, icon, active, onClick }: { label: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={active ? 'page' : undefined}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
        border: 0, borderRadius: 10, textAlign: 'left', cursor: 'pointer',
        background: active ? 'rgba(78,190,206,0.1)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        color: active ? '#7DD8E0' : hover ? '#e4e4e7' : '#9c9ca3',
        transition: 'background 0.14s ease, color 0.14s ease',
      }}
    >
      <Icon path={icon} />
      <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
    </button>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '14px 8px 5px', color: '#5c5c64', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.03em' }}>
      {children}
    </div>
  )
}

function bucketLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const days = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days <= 7) return 'This week'
  return 'Older'
}
const BUCKET_ORDER = ['Today', 'Yesterday', 'This week', 'Older']

function livePriority(operator: LiveOperator): number {
  const name = operator.name?.trim().toLowerCase()
  if (name === 'mrs. max' || name === 'mrs max') return 0
  if (name === 'max') return 1
  return 2
}

/**
 * The merged founder nav — one collapsible surface instead of the old icon
 * rail, a separate top header, and the Caye Direct overlay's own history
 * panel. Everything now-persistent chrome needed lives in one place:
 * the sidebar's own top row (collapse toggle + workspace switcher, inline
 * when open — matches the Claude app shell this was modeled on, where the
 * toggle floats over content only once the sidebar is hidden), New
 * conversation, destinations, search, conversations, and the account menu
 * (Settings folded in there, not a separate rail icon) at the bottom.
 *
 * Two conversation groups sit side by side with no mode toggle to find:
 * "Direct" (the founder's own threads with Caye, grouped by day) and
 * "Team" (read-only visibility into an operator's real WhatsApp
 * conversation with Caye — Mrs. Max, Max, etc.). The old overlay buried
 * Team behind a Chat/Live switch; putting both groups in view at once is
 * what actually restores "I can see what Caye and Mrs. Max are saying"
 * without adding a control to learn.
 */
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
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  function startRename(thread: ThreadListItem) {
    setRenamingId(thread.id)
    setRenameValue(thread.title || '')
    setOpenMenuId(null)
  }

  function commitRename() {
    if (!renamingId) return
    const trimmed = renameValue.trim()
    if (trimmed) onRenameThread(renamingId, trimmed)
    setRenamingId(null)
  }

  const pinnedThreads = (threads ?? [])
    .filter((t) => t.pinned_at)
    .sort((a, b) => new Date(b.pinned_at as string).getTime() - new Date(a.pinned_at as string).getTime())
  const unpinnedThreads = (threads ?? []).filter((t) => !t.pinned_at)
  const groups = BUCKET_ORDER
    .map((label) => ({ label, items: unpinnedThreads.filter((t) => bucketLabel(t.last_activity_at) === label) }))
    .filter((group) => group.items.length > 0)
  const sortedOperators = (operators ?? []).slice().sort((a, b) => livePriority(a) - livePriority(b) || (a.name || '').localeCompare(b.name || ''))

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
            padding: '6px 26px 6px 8px', overflow: 'hidden', border: 0, borderRadius: 8,
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
          onClick={(e) => { e.stopPropagation(); setOpenMenuId((current) => current === thread.id ? null : thread.id) }}
          style={{
            position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
            width: 22, height: 22, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: 0, borderRadius: 6, cursor: 'pointer',
            background: menuOpen ? 'rgba(255,255,255,0.09)' : 'transparent',
            color: menuOpen ? '#f4f4f5' : '#9c9ca3',
          }}
        >
          <Icon path={MORE_ICON} size={13} />
        </button>
        {menuOpen && (
          <ThreadRowMenu
            pinned={!!thread.pinned_at}
            onRename={() => startRename(thread)}
            onTogglePin={() => { onTogglePinThread(thread.id, !thread.pinned_at); setOpenMenuId(null) }}
            onArchive={() => { onArchiveThread(thread.id); setOpenMenuId(null) }}
            onDelete={() => {
              setOpenMenuId(null)
              if (window.confirm(`Delete "${thread.title || 'New conversation'}"? This can't be undone.`)) onDeleteThread(thread.id)
            }}
            onClose={() => setOpenMenuId(null)}
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
          width: collapsed ? 0 : 244, flexShrink: 0, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          background: 'rgba(15,15,17,0.4)',
          marginRight: collapsed ? 0 : 12,
          transition: 'width 0.18s cubic-bezier(.2,.8,.2,1), margin-right 0.18s cubic-bezier(.2,.8,.2,1)',
          ...glass(0.02),
        }}
      >
        <div style={{ width: 244, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 8px 6px', flexShrink: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <WorkspaceSwitcher
                businessName={businessName}
                status={workspaceStatus}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                onSelect={onSelectWorkspace}
                hasActivity={hasActivity}
                menuWidth={216}
              />
            </div>
            <ToggleButton collapsed={collapsed} onToggle={onToggleCollapsed} floating={false} />
          </div>

          <div style={{ padding: '4px 10px 0', flexShrink: 0 }}>
            <button
              type="button"
              onClick={onNewThread}
              disabled={creatingThread}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px',
                border: 0, borderRadius: 10, background: 'rgba(255,255,255,0.04)', color: '#e4e4e7',
                cursor: creatingThread ? 'default' : 'pointer', textAlign: 'left', font: '600 12px inherit',
                opacity: creatingThread ? 0.6 : 1,
              }}
            >
              <Icon path={NEW_CHAT_ICON} size={13} stroke={AQUA} />
              New conversation
            </button>
          </div>

          <div style={{ padding: '10px 11px 0', display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
            {NAV_ITEMS.map((item) => (
              <NavRow
                key={item.id}
                label={item.label}
                icon={item.icon}
                active={activeView.type === 'page' && activeView.id === item.id}
                onClick={() => onSelectPage(item.id)}
              />
            ))}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 8px' }}>
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
                        padding: '6px 8px', overflow: 'hidden', border: 0, borderRadius: 8,
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
                <div style={{ padding: '8px 8px 3px', color: '#5c5c64', fontSize: 9.5, letterSpacing: '0.03em' }}>Pinned</div>
                {pinnedThreads.map((thread) => renderThreadRow(thread))}
              </div>
            )}

            <SectionLabel>Direct</SectionLabel>
            {threads === null ? (
              <div style={{ padding: '6px 8px', color: TEXT_QUIET, fontSize: 11 }}>Loading…</div>
            ) : threads.length === 0 ? (
              <div style={{ padding: '6px 8px', color: TEXT_QUIET, fontSize: 11 }}>No conversations yet.</div>
            ) : (
              groups.map((group) => (
                <div key={group.label}>
                  <div style={{ padding: '8px 8px 3px', color: '#5c5c64', fontSize: 9.5, letterSpacing: '0.03em' }}>
                    {group.label}
                  </div>
                  {group.items.map((thread) => renderThreadRow(thread))}
                </div>
              ))
            )}
          </div>

          <div style={{ padding: '8px 10px 12px', flexShrink: 0 }}>
            <FounderProfile onOpenSettings={() => onSelectPage('settings')} />
          </div>
        </div>
      </nav>
    </>
  )
}
