'use client'

import { useState, type ReactNode } from 'react'
import type { FounderRailId } from '@/lib/types'
import type { WorkspaceMembership } from '@/lib/workspace-context'
import type { CustomerStatus } from '@/types/database'
import FounderProfile from './FounderProfile'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import { AQUA, TEXT_QUIET, glass } from '../surface'

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
const SEARCH_ICON = <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>

function Icon({ path, size = 16, stroke = 'currentColor' }: { path: ReactNode; size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      {path}
    </svg>
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
  operators, onSelectOperator,
  query, onQueryChange,
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
  operators: LiveOperator[] | null
  onSelectOperator: (id: number) => void
  query: string
  onQueryChange: (q: string) => void
  businessName: string
  workspaceStatus: CustomerStatus
  workspaces: WorkspaceMembership[]
  activeWorkspaceId: string
  onSelectWorkspace: (workspaceId: string) => void
  hasActivity: (workspaceId: string) => boolean
}) {
  const groups = BUCKET_ORDER
    .map((label) => ({ label, items: (threads ?? []).filter((t) => bucketLabel(t.last_activity_at) === label) }))
    .filter((group) => group.items.length > 0)
  const sortedOperators = (operators ?? []).slice().sort((a, b) => livePriority(a) - livePriority(b) || (a.name || '').localeCompare(b.name || ''))

  return (
    <>
      {collapsed && <ToggleButton collapsed={collapsed} onToggle={onToggleCollapsed} floating />}

      <nav
        aria-label="Caye Command navigation"
        style={{
          width: collapsed ? 0 : 244, flexShrink: 0, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          background: 'rgba(15,15,17,0.4)',
          transition: 'width 0.18s cubic-bezier(.2,.8,.2,1)',
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

          <div style={{ margin: '10px 11px 0', flexShrink: 0 }}>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px',
              borderRadius: 8, color: TEXT_QUIET, background: 'rgba(255,255,255,0.03)',
            }}>
              <Icon path={SEARCH_ICON} size={12} />
              <input
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="Search"
                aria-label="Search conversations"
                style={{ minWidth: 0, flex: 1, border: 0, outline: 0, background: 'transparent', color: '#f4f4f5', font: '11.5px inherit' }}
              />
            </label>
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
                  {group.items.map((thread) => {
                    const active = activeView.type === 'thread' && activeView.id === thread.id
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        onClick={() => onSelectThread(thread.id)}
                        style={{
                          position: 'relative', width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                          padding: '6px 8px', overflow: 'hidden', border: 0, borderRadius: 8,
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
                    )
                  })}
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
