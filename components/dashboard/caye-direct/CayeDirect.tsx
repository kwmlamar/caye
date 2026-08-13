'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeMark } from '@/components/brand/CayeMark'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { AQUA, TEXT_QUIET, glass, popoverSurface, paneShadowSoft } from '@/components/dashboard/surface'
import CayeDirectThread from './CayeDirectThread'
import OperatorConversationOverlay from './OperatorConversationOverlay'

interface Operator {
  id: number
  name: string | null
  role: 'owner' | 'staff' | 'founder'
}

interface ThreadListItem {
  id: string
  title: string | null
  status: 'active' | 'archived'
  last_activity_at: string
  created_by: 'founder' | 'caye'
}

const ROLE_LABEL: Record<Operator['role'], string> = { founder: 'Founder', owner: 'Owner', staff: 'Staff' }

function operatorLabel(op: Operator): string {
  if (op.name) return op.name
  return op.role === 'founder' ? 'You' : ROLE_LABEL[op.role]
}

function storageKey(workspaceId: string): string {
  return `caye-direct-selected-thread:${workspaceId}`
}

// Today / Yesterday / Previous 7 days / Older — visual grouping only,
// purely a sidebar affordance. Threads themselves are never partitioned
// by day in storage; see supabase/migrations/20260813_caye_direct_threads.sql.
function bucketLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const days = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days <= 7) return 'Previous 7 days'
  return 'Older'
}
const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Older']

function ThreadRow({ thread, active, onClick }: { thread: ThreadListItem; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', display: 'block', width: '100%', textAlign: 'left',
        border: 'none', cursor: 'pointer', borderRadius: 8, padding: '7px 10px 7px 13px', marginBottom: 1,
        background: active ? 'rgba(78,190,206,0.09)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        transition: 'background 0.12s ease',
      }}
    >
      {active && (
        <span aria-hidden style={{ position: 'absolute', left: 3, top: 6, bottom: 6, width: 2.5, borderRadius: 3, background: AQUA }} />
      )}
      <div style={{
        fontSize: 12.5, fontWeight: 500, color: thread.title ? '#f4f4f5' : '#71717a',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        {thread.created_by === 'caye' && (
          <span aria-hidden title="Caye started this" style={{ width: 5, height: 5, borderRadius: '50%', background: AQUA, flexShrink: 0 }} />
        )}
        {thread.title || 'New conversation'}
      </div>
    </button>
  )
}

function OperatorsPopover({
  operators, onSelect, onClose,
}: {
  operators: Operator[]
  onSelect: (op: Operator) => void
  onClose: () => void
}) {
  const nonFounder = operators.filter((o) => o.role !== 'founder')
  return (
    <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, width: 230, zIndex: 50, borderRadius: 12, overflow: 'hidden', ...popoverSurface(), boxShadow: paneShadowSoft }}>
      <div style={{ padding: '10px 12px 8px', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', color: TEXT_QUIET, textTransform: 'uppercase' }}>
        Business operators
      </div>
      {nonFounder.length === 0 ? (
        <div style={{ padding: '4px 12px 12px', fontSize: 11.5, color: TEXT_QUIET }}>No operators yet.</div>
      ) : (
        nonFounder.map((op) => (
          <button
            key={op.id}
            onClick={() => { onSelect(op); onClose() }}
            style={{
              display: 'flex', flexDirection: 'column', width: '100%', textAlign: 'left',
              border: 'none', cursor: 'pointer', background: 'transparent', padding: '8px 12px',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#f4f4f5' }}>{operatorLabel(op)}</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: TEXT_QUIET }}>{ROLE_LABEL[op.role]} · WhatsApp</span>
          </button>
        ))
      )}
    </div>
  )
}

interface CayeDirectProps {
  workspaceId: string
  /** Passed through from TalkToCaye's bottom composer. */
  initialMessage?: string | null
  onInitialMessageSent?: () => void
}

// Caye Direct — a persistent, topic-based conversation history with Caye
// (2026-08-13 redesign), NOT a per-person chat switcher. Left rail is
// thread history; business operators (Max, Mrs. Max) live behind the
// "Operators" popover as read-only observability, not sidebar
// destinations — see OperatorConversationOverlay.
export default function CayeDirect({ workspaceId, initialMessage, onInitialMessageSent }: CayeDirectProps) {
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [operators, setOperators] = useState<Operator[]>([])
  const [showOperators, setShowOperators] = useState(false)
  const [viewingOperator, setViewingOperator] = useState<Operator | null>(null)
  const [creating, setCreating] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadThreads = useCallback(async (q: string, status: 'active' | 'archived' = 'active'): Promise<ThreadListItem[] | null> => {
    const { session } = await getSession()
    if (!session) return null
    const url = `/api/founder/caye-direct/threads?workspaceId=${workspaceId}&status=${status}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
    const json = await res.json()
    return res.ok ? (json.threads as ThreadListItem[]) : null
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    setThreads(null)
    setSelectedId(null)
    setShowArchived(false)
    async function load() {
      const list = await loadThreads('')
      if (cancelled) return
      setThreads(list ?? [])
      let remembered: string | null = null
      try { remembered = window.localStorage.getItem(storageKey(workspaceId)) } catch {}
      const rememberedValid = remembered && (list ?? []).some((t) => t.id === remembered)
      setSelectedId(rememberedValid ? remembered : (list ?? [])[0]?.id ?? null)
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId, loadThreads])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch(`/api/founder/caye-operators?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!cancelled && res.ok) setOperators(json.operators ?? [])
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId])

  // Debounced search — refetch the thread list, don't touch selection
  // unless the currently selected thread fell out of the filtered results.
  // Re-runs on showArchived too, so toggling Active/Archived is just
  // another facet of the same query rather than a separate code path.
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(async () => {
      const list = await loadThreads(query, showArchived ? 'archived' : 'active')
      if (list) {
        setThreads(list)
        if (selectedId && !list.some((t) => t.id === selectedId)) {
          setSelectedId(list[0]?.id ?? null)
        }
      }
    }, 250)
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, showArchived])

  function selectThread(id: string) {
    setSelectedId(id)
    try { window.localStorage.setItem(storageKey(workspaceId), id) } catch {}
  }

  async function createThread(): Promise<string | null> {
    setCreating(true)
    try {
      const { session } = await getSession()
      if (!session) return null
      const res = await fetch('/api/founder/caye-direct/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ workspaceId }),
      })
      const json = await res.json()
      if (!res.ok || !json.thread) return null
      const newThread: ThreadListItem = json.thread
      // A fresh conversation is always active — if the founder was
      // browsing Archived, switch the list back so the new thread is
      // actually visible in it rather than injected into a filtered view.
      setShowArchived(false)
      setThreads((prev) => [newThread, ...(prev ?? [])])
      selectThread(newThread.id)
      return newThread.id
    } finally {
      setCreating(false)
    }
  }

  // The bottom composer (TalkToCaye/CayeLauncher) always wants a thread to
  // land in. If nothing's selected yet, create one and hand it the draft.
  const [pendingInitialThreadId, setPendingInitialThreadId] = useState<string | null>(null)
  useEffect(() => {
    if (!initialMessage || threads === null) return
    if (selectedId) { setPendingInitialThreadId(selectedId); return }
    createThread().then((id) => { if (id) setPendingInitialThreadId(id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, threads])

  function updateThreadMeta(id: string, meta: { title: string | null }) {
    setThreads((prev) => (prev ?? []).map((t) => (t.id === id ? { ...t, title: meta.title } : t)))
  }

  // Archiving is a visibility toggle, not a delete — the thread drops out
  // of whichever list is currently showing (it moved to the other one).
  function handleThreadArchived(id: string) {
    setThreads((prev) => (prev ?? []).filter((t) => t.id !== id))
    setSelectedId((cur) => (cur === id ? null : cur))
  }

  const selected = threads?.find((t) => t.id === selectedId) ?? null

  const grouped: Array<{ label: string; items: ThreadListItem[] }> = []
  for (const label of BUCKET_ORDER) {
    const items = (threads ?? []).filter((t) => bucketLabel(t.last_activity_at) === label)
    if (items.length > 0) grouped.push({ label, items })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', color: '#f4f4f5' }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '8px 14px', flexShrink: 0, boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)' }}>
        <button
          onClick={() => setShowOperators((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, border: 'none', cursor: 'pointer',
            background: 'transparent', color: TEXT_QUIET, fontSize: 11, fontFamily: 'var(--font-mono)', padding: '4px 6px', borderRadius: 6,
          }}
        >
          Operators {operators.filter((o) => o.role !== 'founder').length}
        </button>
        {showOperators && (
          <OperatorsPopover
            operators={operators}
            onClose={() => setShowOperators(false)}
            onSelect={(op) => setViewingOperator(op)}
          />
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 200, flexShrink: 0, background: 'rgba(255,255,255,0.015)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 10px 8px' }}>
            <button
              onClick={() => createThread()}
              disabled={creating}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, width: '100%',
                border: 'none', cursor: creating ? 'default' : 'pointer', borderRadius: 9,
                padding: '8px 10px', fontSize: 12, fontWeight: 600, color: '#f4f4f5',
                ...glass(0.045),
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={AQUA} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New conversation
            </button>
          </div>
          <div style={{ padding: '0 10px 8px' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              style={{
                width: '100%', fontSize: 11.5, padding: '6px 9px', borderRadius: 7,
                background: 'rgba(255,255,255,0.03)', border: 'none', color: '#f4f4f5', outline: 'none',
              }}
            />
          </div>
          <div style={{ padding: '0 6px 8px', flex: 1, overflowY: 'auto' }}>
            {threads === null ? (
              <div style={{ padding: '6px 8px' }}><CayeLoadingPulse size={13} /></div>
            ) : threads.length === 0 ? (
              <div style={{ fontSize: 11, color: '#52525b', padding: '6px 8px' }}>
                {showArchived ? 'No archived conversations.' : 'No conversations yet.'}
              </div>
            ) : (
              grouped.map((g) => (
                <div key={g.label} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', color: '#52525b', textTransform: 'uppercase', padding: '4px 7px 3px' }}>
                    {g.label}
                  </div>
                  {g.items.map((t) => (
                    <ThreadRow key={t.id} thread={t} active={t.id === selectedId} onClick={() => selectThread(t.id)} />
                  ))}
                </div>
              ))
            )}
          </div>
          <button
            onClick={() => { setShowArchived((v) => !v); setThreads(null); setSelectedId(null) }}
            style={{
              flexShrink: 0, border: 'none', cursor: 'pointer', background: 'transparent',
              color: '#52525b', fontSize: 10.5, fontFamily: 'var(--font-mono)',
              padding: '8px 12px', textAlign: 'left',
            }}
          >
            {showArchived ? '← Active conversations' : 'Archived conversations'}
          </button>
        </div>

        {selected ? (
          <CayeDirectThread
            key={selected.id}
            mode="thread"
            workspaceId={workspaceId}
            threadId={selected.id}
            threadTitle={selected.title}
            onThreadMeta={(meta) => updateThreadMeta(selected.id, meta)}
            onArchive={() => handleThreadArchived(selected.id)}
            initialMessage={pendingInitialThreadId === selected.id ? initialMessage : null}
            onInitialMessageSent={() => { setPendingInitialThreadId(null); onInitialMessageSent?.() }}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#52525b', fontSize: 13, gap: 10 }}>
            {threads === null ? <CayeLoadingPulse size={18} /> : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <CayeMark size={32} />
                <span>Start a conversation with Caye.</span>
              </div>
            )}
          </div>
        )}
      </div>

      {viewingOperator && (
        <OperatorConversationOverlay
          workspaceId={workspaceId}
          operatorId={viewingOperator.id}
          operatorLabel={operatorLabel(viewingOperator)}
          onClose={() => setViewingOperator(null)}
        />
      )}
    </div>
  )
}
