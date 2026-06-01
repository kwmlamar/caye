'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import Avatar from '@/components/ui/Avatar'
import { useDashboard } from '@/lib/dashboard-context'
import { useWorkspace } from '@/lib/workspace-context'
import { CayeLogo } from '@/components/brand/CayeLogo'
import { getSupabase } from '@/lib/supabase'
import ThreadRowMenu from './ThreadRowMenu'
import type { Screen } from '@/lib/types'

async function authHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await getSupabase().auth.getSession()
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token || ''}`,
  }
}

const SCREENS = [
  { id: 'home' as Screen, label: 'Home', icon: 'home' },
  { id: 'chats' as Screen, label: 'Inbox', icon: 'chat' },
  { id: 'bookings' as Screen, label: 'Bookings', icon: 'bookings' },
  { id: 'calendar' as Screen, label: 'Calendar', icon: 'cal' },
  { id: 'contacts' as Screen, label: 'Contacts', icon: 'contacts' },
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
    case 'home':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="m3 9 7-6 7 6v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" /><path d="M9 17V11h2v6" /></svg>
    case 'chat':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><path d="M3 5.5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8.5L5 16.5v-3H5a2 2 0 0 1-2-2v-6z" /></svg>
    case 'bookings':
      return <svg width={s} height={s} viewBox="0 0 20 20" {...st}><rect x="3" y="3" width="14" height="14" rx="2" /><path d="m9 11 2 2 4-4M3 8h14" /></svg>
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
  workspace: ReturnType<typeof useWorkspace>['workspace']
  currentId: string
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onSelect: (id: string) => void
  onClose: () => void
  sidebarExpanded: boolean
}

function WorkspaceSwitcher({
  workspaces,
  workspace,
  currentId,
  anchorRef,
  onSelect,
  onClose,
  sidebarExpanded,
}: WorkspaceSwitcherProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const [pos, setPos] = useState({ top: 0, left: 0, width: 220 })

  useEffect(() => {
    if (anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect()
      if (sidebarExpanded) {
        setPos({
          top: r.bottom + 6,
          left: r.left,
          width: Math.max(r.width, 220),
        })
      } else {
        setPos({
          top: r.top,
          left: r.right + 8,
          width: 220,
        })
      }
    }
  }, [anchorRef, sidebarExpanded])

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleDown)
    return () => document.removeEventListener('mousedown', handleDown)
  }, [anchorRef, onClose])

  const handleLogout = async () => {
    onClose()
    await getSupabase().auth.signOut()
    router.push('/login')
  }

  const handleLinkClick = (url: string) => {
    onClose()
    router.push(url)
  }

  const initials = (workspace?.business_name || 'M').charAt(0).toUpperCase()
  const fullName = workspace?.full_name || workspace?.business_name || 'My Workspace'
  const email = workspace?.contact_email || ''
  const status = workspace?.status || 'trial'
  const statusText = status.charAt(0).toUpperCase() + status.slice(1)

  // Filter other workspaces
  const otherWorkspaces = workspaces.filter((w) => w.workspace_id !== currentId)

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        width: pos.width,
        background: '#ffffff',
        border: '1px solid rgba(14, 26, 26, 0.08)',
        borderRadius: 14,
        boxShadow: '0 8px 32px rgba(14, 26, 26, 0.08), 0 2px 8px rgba(14, 26, 26, 0.04)',
        overflow: 'hidden',
      }}
      className="user-dropdown-popover"
    >
      {/* Header Profile Info */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderBottom: '1px solid rgba(14, 26, 26, 0.05)',
      }}>
        {workspace?.avatar_url ? (
          <img
            src={workspace.avatar_url}
            alt={fullName}
            style={{ width: 34, height: 34, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
          />
        ) : (
          <div style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            background: 'rgba(14, 26, 26, 0.05)',
            color: '#0E1A1A',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 600,
            flexShrink: 0
          }}>
            {initials}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#0E1A1A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {fullName}
          </span>
          <span style={{ fontSize: 11, color: 'rgba(14, 26, 26, 0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
            {statusText} • {email}
          </span>
        </div>
      </div>

      {/* Main Actions */}
      <div style={{ padding: '6px 6px' }}>
        <button
          onClick={() => handleLinkClick(`/dashboard/${currentId}/settings?tab=workspace`)}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '7px 10px',
            borderRadius: 8,
            background: 'transparent',
            color: 'rgba(14, 26, 26, 0.75)',
            fontSize: 13,
            fontWeight: 500,
            textAlign: 'left',
            cursor: 'pointer',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
          onMouseEnter={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(14, 26, 26, 0.03)'
            ;(e.currentTarget as HTMLButtonElement).style.color = '#0E1A1A'
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(14, 26, 26, 0.75)'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 10, opacity: 0.6 }}>
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <line x1="20" y1="8" x2="20" y2="14" />
            <line x1="23" y1="11" x2="17" y2="11" />
          </svg>
          Invite members
        </button>

        <button
          onClick={() => handleLinkClick(`/dashboard/${currentId}/settings`)}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '7px 10px',
            borderRadius: 8,
            background: 'transparent',
            color: 'rgba(14, 26, 26, 0.75)',
            fontSize: 13,
            fontWeight: 500,
            textAlign: 'left',
            cursor: 'pointer',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
          onMouseEnter={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(14, 26, 26, 0.03)'
            ;(e.currentTarget as HTMLButtonElement).style.color = '#0E1A1A'
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(14, 26, 26, 0.75)'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 10, opacity: 0.6 }}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Settings
        </button>

        <button
          onClick={() => handleLinkClick(`/dashboard/${currentId}`)}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '7px 10px',
            borderRadius: 8,
            background: 'transparent',
            color: 'rgba(14, 26, 26, 0.75)',
            fontSize: 13,
            fontWeight: 500,
            textAlign: 'left',
            cursor: 'pointer',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
          onMouseEnter={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(14, 26, 26, 0.03)'
            ;(e.currentTarget as HTMLButtonElement).style.color = '#0E1A1A'
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(14, 26, 26, 0.75)'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 10, opacity: 0.6 }}>
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          Caye Guide
        </button>

        <button
          onClick={() => handleLinkClick(`/dashboard/${currentId}`)}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '7px 10px',
            borderRadius: 8,
            background: 'transparent',
            color: 'rgba(14, 26, 26, 0.75)',
            fontSize: 13,
            fontWeight: 500,
            textAlign: 'left',
            cursor: 'pointer',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
          onMouseEnter={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(14, 26, 26, 0.03)'
            ;(e.currentTarget as HTMLButtonElement).style.color = '#0E1A1A'
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
            ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(14, 26, 26, 0.75)'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 10, opacity: 0.6 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          Documentation
        </button>
      </div>

      {/* Switch Workspace Section (if multiple exist) */}
      {otherWorkspaces.length > 0 && (
        <>
          <div style={{ height: 1, background: 'rgba(14, 26, 26, 0.05)', margin: '4px 0' }} />
          <div style={{
            padding: '10px 14px 6px',
          }}>
            <p style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'rgba(14, 26, 26, 0.4)',
              margin: 0,
            }}>
              Switch workspace
            </p>
          </div>
          <div style={{ padding: '0 6px 6px' }}>
            {otherWorkspaces.map((m) => {
              const name = m.customer.business_name || 'Unnamed workspace'
              return (
                <button
                  key={m.workspace_id}
                  onClick={() => {
                    onClose()
                    onSelect(m.workspace_id)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '7px 9px',
                    borderRadius: 9,
                    background: 'transparent',
                    color: 'rgba(14, 26, 26, 0.7)',
                    fontSize: 13,
                    fontWeight: 500,
                    textAlign: 'left',
                    transition: 'background 0.12s ease',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(14, 26, 26, 0.03)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
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
                  <span style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'rgba(14, 26, 26, 0.35)', flexShrink: 0, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {m.role}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* Logout Action */}
      <div style={{ height: 1, background: 'rgba(14, 26, 26, 0.05)', margin: '4px 0' }} />
      <div style={{ padding: '4px 6px 6px' }}>
        <button
          onClick={handleLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '7px 10px',
            borderRadius: 8,
            background: 'transparent',
            color: '#E85A3C',
            fontSize: 13,
            fontWeight: 500,
            textAlign: 'left',
            cursor: 'pointer',
            transition: 'background 0.12s ease',
          }}
          onMouseEnter={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'rgba(232, 90, 60, 0.06)'
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 10 }}>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Logout
        </button>
      </div>
    </div>,
    document.body
  )
}

interface CayeThread {
  id: string
  title: string | null
  updated_at: string
}

interface SidebarProps {
  workspaceId: string
}

export default function Sidebar({ workspaceId }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { setPanelOpen, sidebarExpanded, setSidebarExpanded } = useDashboard()
  const { workspace, workspaces } = useWorkspace()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const userButtonRef = useRef<HTMLButtonElement>(null)
  
  const [threads, setThreads] = useState<CayeThread[]>([])

  const isSettings = pathname?.includes('/settings') ?? false
  const bizName = workspace?.business_name || 'My Workspace'
  const bizWords = bizName.trim().split(' ')
  const shortName = bizWords[0] + (bizWords[1] ? ' ' + bizWords[1][0] + '.' : '')
  const timezone = workspace?.timezone
    ? workspace.timezone.split('/')[1]?.replace(/_/g, ' ').toLowerCase() || workspace.timezone
    : ''

  const handleSelectWorkspace = useCallback((id: string) => {
    setSwitcherOpen(false)
    if (id !== workspaceId) {
      localStorage.setItem('lastActiveWorkspaceId', id)
      router.push(`/dashboard/${id}`)
    }
  }, [workspaceId, router])

  const hasMultiple = workspaces.length > 1

  const [menuFor, setMenuFor] = useState<{ id: string; el: HTMLElement } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)

  // Track which thread is currently active (read from localStorage). We need
  // this so we can hide *other* empty/untitled threads from the sidebar — only
  // the active untitled thread should appear.
  useEffect(() => {
    const read = () => setActiveId(localStorage.getItem(`caye_active_thread_id_${workspaceId}`))
    read()
    const onSelected = () => read()
    window.addEventListener('caye-thread-selected', onSelected)
    window.addEventListener('caye-threads-updated', onSelected)
    return () => {
      window.removeEventListener('caye-thread-selected', onSelected)
      window.removeEventListener('caye-threads-updated', onSelected)
    }
  }, [workspaceId])

  const fetchThreads = useCallback(async () => {
    try {
      const res = await fetch(`/api/caye/threads?workspaceId=${workspaceId}`, {
        headers: await authHeaders(),
      })
      if (res.ok) setThreads(await res.json())
    } catch (e) {
      console.error(e)
    }
  }, [workspaceId])

  useEffect(() => {
    fetchThreads()
    const handler = () => fetchThreads()
    window.addEventListener('caye-threads-updated', handler)
    return () => window.removeEventListener('caye-threads-updated', handler)
  }, [fetchThreads])

  const groupedThreads = useMemo(() => {
    const now = new Date()
    const today: CayeThread[] = []
    const yesterday: CayeThread[] = []
    const thisWeek: CayeThread[] = []

    // Hide zero-message / untitled threads. Title gets set the moment the first
    // message lands, so "no title" is the proxy for "no messages". A fresh
    // `+ New chat` shows as an empty-state canvas, not a sidebar row.
    const visibleThreads = threads.filter(t => t.title && t.title.trim().length > 0)

    visibleThreads.forEach(t => {
      const date = new Date(t.updated_at)
      const diffTime = Math.abs(now.getTime() - date.getTime())
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

      if (diffDays <= 1) {
        today.push(t)
      } else if (diffDays === 2) {
        yesterday.push(t)
      } else {
        thisWeek.push(t)
      }
    })

    return { today, yesterday, thisWeek }
  }, [threads])

  const handleSelectThread = (threadId: string) => {
    localStorage.setItem(`caye_active_thread_id_${workspaceId}`, threadId)
    window.dispatchEvent(new CustomEvent('caye-thread-selected', { detail: threadId }))
    if (pathname?.includes('/settings')) {
      router.push(`/dashboard/${workspaceId}`)
    }
  }

  const newChatInFlightRef = useRef(false)
  const handleAskCaye = async () => {
    if (newChatInFlightRef.current) return

    // If the most recent thread has no title (i.e. has no messages yet), reuse it
    // instead of creating another empty one.
    if (threads.length > 0 && !threads[0].title) {
      handleSelectThread(threads[0].id)
      return
    }

    newChatInFlightRef.current = true
    try {
      const res = await fetch('/api/caye/threads', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ workspaceId }),
      })
      if (!res.ok) return
      const thread = (await res.json()) as CayeThread
      setThreads(prev => [{ id: thread.id, title: thread.title, updated_at: thread.updated_at }, ...prev])
      localStorage.setItem(`caye_active_thread_id_${workspaceId}`, thread.id)
      window.dispatchEvent(new CustomEvent('caye-thread-selected', { detail: thread.id }))
      if (pathname?.includes('/settings')) {
        router.push(`/dashboard/${workspaceId}`)
      }
    } finally {
      setTimeout(() => { newChatInFlightRef.current = false }, 400)
    }
  }

  const commitRename = async (threadId: string) => {
    const title = renameValue.trim()
    setRenamingId(null)
    if (!title) return
    setThreads(prev => prev.map(t => t.id === threadId ? { ...t, title } : t))
    await fetch(`/api/caye/threads/${threadId}`, {
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify({ title }),
    })
  }

  const handleDeleteThread = async (threadId: string) => {
    if (!window.confirm("Delete this conversation? Caye won't remember it.")) return
    setThreads(prev => prev.filter(t => t.id !== threadId))
    const activeId = localStorage.getItem(`caye_active_thread_id_${workspaceId}`)
    await fetch(`/api/caye/threads/${threadId}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    })
    if (activeId === threadId) {
      localStorage.removeItem(`caye_active_thread_id_${workspaceId}`)
      handleAskCaye()
    }
  }

  return (
    <>
      <nav
        className={'sidebar' + (sidebarExpanded ? ' expanded' : '')}
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      >
        <div className="sb-top" style={{ flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
            {/* Workspace Switcher at the top */}
            <button
              ref={userButtonRef}
              className={'sb-item sb-user' + (switcherOpen ? ' active' : '')}
              title={bizName}
              onClick={() => setSwitcherOpen(v => !v)}
              style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}
            >
              {workspace?.avatar_url ? (
                <img
                  src={workspace.avatar_url}
                  alt={bizName}
                  style={{ width: 26, height: 26, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                />
              ) : (
                <Avatar name={bizName} size={26} />
              )}
              <span className="sb-label font-semibold text-near-black/90" style={{ width: '100%' }}>
                <span className="sb-user-name text-left" style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%' }}>
                  <span className="truncate flex-1">{bizName}</span>
                  <span style={{ opacity: 0.4, marginLeft: 'auto', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                    <NavIcon name="chevron" size={12} />
                  </span>
                </span>
              </span>
            </button>

            {/* Collapse Sidebar Button (visible only when expanded) */}
            <button
              onClick={() => setSidebarExpanded(false)}
              className="sb-collapse-btn"
              title="Collapse sidebar"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'rgba(14, 26, 26, 0.4)',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = 'rgba(14, 26, 26, 0.05)'
                e.currentTarget.style.color = 'rgba(14, 26, 26, 0.8)'
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = 'rgba(14, 26, 26, 0.4)'
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
            </button>
          </div>

          {/* Primary "+ New chat" button */}
          <button
            onClick={handleAskCaye}
            className="sb-new-chat-btn"
            title="New chat"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span className="sb-label">New chat</span>
          </button>
        </div>

        {/* Recent threads list (Caye conversations) filling the middle */}
        <div className="flex-1 overflow-y-auto py-2 transition-opacity duration-200" style={{ display: sidebarExpanded ? 'block' : 'none', minHeight: 0 }}>
          {(groupedThreads.today.length + groupedThreads.yesterday.length + groupedThreads.thisWeek.length) > 0 && (
            <span className="sb-section-label px-2" style={{ paddingLeft: 8, display: 'block', marginBottom: 8 }}>Recent Chats</span>
          )}

          <div className="space-y-1 px-2">
            {(['today', 'yesterday', 'thisWeek'] as const).map(group => {
              const list = groupedThreads[group]
              if (list.length === 0) return null
              const label = group === 'today' ? 'Today' : group === 'yesterday' ? 'Yesterday' : 'This week'
              return (
                <div key={group} style={{ marginBottom: 12 }}>
                  <div className="text-[10px] uppercase font-mono font-semibold tracking-wider text-near-black/35 px-2 py-1">{label}</div>
                  {list.map(t => {
                    const isRenaming = renamingId === t.id
                    const displayTitle = t.title?.trim() || 'New chat'
                    return (
                      <div key={t.id} className="group relative flex items-center rounded hover:bg-[#0E1A1A]/5">
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => commitRename(t.id)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); commitRename(t.id) }
                              else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                            }}
                            className="flex-1 bg-white border border-[rgba(14,26,26,0.15)] rounded px-2 py-1 mx-1 text-[12.5px] text-near-black outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => handleSelectThread(t.id)}
                            className="flex-1 text-left px-2 py-1.5 text-[12.5px] text-near-black/60 group-hover:text-near-black truncate min-w-0"
                            style={{ textAlign: 'left' }}
                          >
                            {displayTitle}
                          </button>
                        )}
                        {!isRenaming && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setMenuFor({ id: t.id, el: e.currentTarget })
                            }}
                            className="opacity-0 group-hover:opacity-100 px-1.5 py-1 mr-1 rounded text-near-black/50 hover:text-near-black hover:bg-[#0E1A1A]/5 transition-opacity"
                            title="More"
                            aria-label="Thread options"
                          >
                            <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <circle cx="4" cy="10" r="1.5" />
                              <circle cx="10" cy="10" r="1.5" />
                              <circle cx="16" cy="10" r="1.5" />
                            </svg>
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        {menuFor && (
          <ThreadRowMenu
            anchorEl={menuFor.el}
            onClose={() => setMenuFor(null)}
            onRename={() => {
              const t = threads.find(x => x.id === menuFor.id)
              setRenameValue(t?.title || '')
              setRenamingId(menuFor.id)
            }}
            onDelete={() => handleDeleteThread(menuFor.id)}
          />
        )}

        {/* Settings Link at the very bottom */}
        <div className="sb-settings-container">
          <Link
            href={`/dashboard/${workspaceId}/settings`}
            className={'sb-item' + (isSettings ? ' active' : '')}
            title="Settings"
          >
            <span className="sb-icon"><NavIcon name="settings" size={18} /></span>
            <span className="sb-label">Settings</span>
          </Link>
        </div>
      </nav>

      {switcherOpen && (
        <WorkspaceSwitcher
          workspaces={workspaces}
          workspace={workspace}
          currentId={workspaceId}
          anchorRef={userButtonRef}
          onSelect={handleSelectWorkspace}
          onClose={() => setSwitcherOpen(false)}
          sidebarExpanded={sidebarExpanded}
        />
      )}
    </>
  )
}
