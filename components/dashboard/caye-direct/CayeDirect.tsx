'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeMark } from '@/components/brand/CayeMark'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { AQUA } from '@/components/dashboard/surface'
import CayeDirectThread from './CayeDirectThread'
import { liveOperatorDisplayNames } from '@/lib/operator-display-name'

interface ThreadListItem {
  id: string
  title: string | null
  status: 'active' | 'archived'
  last_activity_at: string
  created_by: 'founder' | 'caye'
}

interface LiveOperator {
  id: number
  name: string | null
  role: 'owner' | 'staff' | 'founder'
}

type CayeMode = 'chat' | 'live'

interface CayeDirectProps {
  workspaceId: string
  workspaceName: string
  open: boolean
  onClose: () => void
  initialMessage?: string | null
  onInitialMessageSent?: () => void
  initialMode?: CayeMode
}

const BUCKET_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Older']

function storageKey(workspaceId: string): string {
  return `caye-direct-selected-thread:${workspaceId}`
}

function livePriority(operator: LiveOperator): number {
  const name = operator.name?.trim().toLowerCase()
  if (name === 'mrs. max' || name === 'mrs max') return 0
  if (name === 'max') return 1
  return 2
}

// This is display-only history grouping. Direct threads remain persistent,
// topic-based records regardless of which day heading they appear under.
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

function ThreadRow({ thread, active, onClick }: { thread: ThreadListItem; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`caye-overlay-thread-row ${active ? 'is-active' : ''}`}>
      {thread.created_by === 'caye' && <span className="caye-overlay-thread-origin" aria-label="Started by Caye" />}
      <span>{thread.title || 'New conversation'}</span>
    </button>
  )
}

/**
 * The single Caye Direct presentation: a persistent, modal conversation
 * surface over the founder's current page. Chat is the founder's persistent
 * Direct history; Live is the existing read-only operator WhatsApp lens.
 * Keeping the component mounted while closed preserves selected-thread state,
 * scroll position, and an unsent composer draft between summons.
 */
export default function CayeDirect({ workspaceId, workspaceName, open, onClose, initialMessage, onInitialMessageSent, initialMode = 'chat' }: CayeDirectProps) {
  const [threads, setThreads] = useState<ThreadListItem[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [pendingInitialThreadId, setPendingInitialThreadId] = useState<string | null>(null)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [emptyDraft, setEmptyDraft] = useState('')
  const [mode, setMode] = useState<CayeMode>(initialMode)
  const [operators, setOperators] = useState<LiveOperator[] | null>(null)
  const [selectedOperatorId, setSelectedOperatorId] = useState<number | null>(null)
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const emptyInputRef = useRef<HTMLInputElement>(null)
  const previousBodyOverflow = useRef('')
  const previousHtmlOverflow = useRef('')
  const scrollPosition = useRef(0)

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
    setQuery('')
    async function load() {
      const list = await loadThreads('')
      if (cancelled) return
      setThreads(list ?? [])
      let remembered: string | null = null
      try { remembered = window.localStorage.getItem(storageKey(workspaceId)) } catch {}
      const rememberedValid = remembered && (list ?? []).some((thread) => thread.id === remembered)
      setSelectedId(rememberedValid ? remembered : (list ?? [])[0]?.id ?? null)
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId, loadThreads])

  useEffect(() => {
    let cancelled = false
    setOperators(null)
    setSelectedOperatorId(null)
    async function loadOperators() {
      const { session } = await getSession()
      if (!session) return
      const response = await fetch(`/api/founder/caye-operators?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await response.json()
      if (cancelled || !response.ok) return
      // Founders have their own Direct history; Live is for the people Caye
      // is monitoring over WhatsApp. The API supplies no activity timestamps,
      // so the UI deliberately does not manufacture any.
      const list = (json.operators as LiveOperator[])
        .filter((operator) => operator.role !== 'founder')
        .sort((a, b) => livePriority(a) - livePriority(b) || (a.name || '').localeCompare(b.name || ''))
      setOperators(list)
      setSelectedOperatorId((current) => current && list.some((operator) => operator.id === current) ? current : (list[0]?.id ?? null))
    }
    loadOperators()
    return () => { cancelled = true }
  }, [workspaceId])

  useEffect(() => {
    if (open) setMode(initialMode)
  }, [open, initialMode])

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(async () => {
      const list = await loadThreads(query, showArchived ? 'archived' : 'active')
      if (!list) return
      setThreads(list)
      if (selectedId && !list.some((thread) => thread.id === selectedId)) setSelectedId(list[0]?.id ?? null)
    }, 250)
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current) }
    // Selection intentionally remains stable unless the filtered list no longer contains it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, showArchived])

  useEffect(() => {
    if (!open) return
    scrollPosition.current = window.scrollY
    previousBodyOverflow.current = document.body.style.overflow
    previousHtmlOverflow.current = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousBodyOverflow.current
      document.documentElement.style.overflow = previousHtmlOverflow.current
      window.scrollTo(0, scrollPosition.current)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open || mode !== 'chat' || selectedId) return
    const frame = requestAnimationFrame(() => emptyInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, mode, selectedId])

  function selectThread(id: string) {
    setSelectedId(id)
    setMobileHistoryOpen(false)
    try { window.localStorage.setItem(storageKey(workspaceId), id) } catch {}
  }

  function selectMode(nextMode: CayeMode) {
    setMode(nextMode)
    setMobileHistoryOpen(false)
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
      const thread: ThreadListItem = json.thread
      setShowArchived(false)
      setThreads((current) => [thread, ...(current ?? [])])
      selectThread(thread.id)
      return thread.id
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    if (!initialMessage || threads === null) return
    if (selectedId) { setPendingInitialThreadId(selectedId); setPendingMessage(initialMessage); return }
    createThread().then((id) => { if (id) setPendingInitialThreadId(id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, threads])

  function updateThreadMeta(id: string, meta: { title: string | null }) {
    setThreads((current) => (current ?? []).map((thread) => thread.id === id ? { ...thread, title: meta.title } : thread))
  }

  function archiveThread(id: string) {
    setThreads((current) => (current ?? []).filter((thread) => thread.id !== id))
    setSelectedId((current) => current === id ? null : current)
  }

  async function startFromEmptyState() {
    const message = emptyDraft.trim()
    if (!message || creating) return
    const id = await createThread()
    if (!id) return
    setPendingMessage(message)
    setPendingInitialThreadId(id)
    setEmptyDraft('')
  }

  const selected = threads?.find((thread) => thread.id === selectedId) ?? null
  const selectedOperator = operators?.find((operator) => operator.id === selectedOperatorId) ?? null
  const liveOperatorLabels = liveOperatorDisplayNames(operators ?? [])
  const groups = BUCKET_ORDER.map((label) => ({ label, items: (threads ?? []).filter((thread) => bucketLabel(thread.last_activity_at) === label) })).filter((group) => group.items.length > 0)

  return (
    <div className={`caye-overlay ${open ? 'is-open' : ''}`} aria-hidden={!open} inert={!open}>
      <style>{`
        .caye-overlay { position:fixed; inset:0; z-index:240; display:flex; align-items:center; justify-content:center; padding:clamp(18px,4vh,42px) clamp(18px,5vw,72px); opacity:0; pointer-events:none; transition:opacity .2s ease; }
        .caye-overlay.is-open { opacity:1; pointer-events:auto; }
        .caye-overlay-backdrop { position:absolute; inset:0; background:rgba(3,5,8,.48); backdrop-filter:blur(10px) saturate(80%); -webkit-backdrop-filter:blur(10px) saturate(80%); }
        .caye-overlay-surface { position:relative; display:flex; width:min(1050px,100%); height:min(790px,92vh); min-height:520px; overflow:hidden; border-radius:18px; background:rgba(13,14,17,.93); box-shadow:0 30px 90px rgba(0,0,0,.56), 0 1px 0 rgba(255,255,255,.08) inset; transform:translateY(10px) scale(.985); transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .18s ease; }
        .caye-overlay.is-open .caye-overlay-surface { transform:translateY(0) scale(1); }
        .caye-overlay-history { width:220px; flex:0 0 220px; display:flex; flex-direction:column; min-height:0; padding:12px 8px 10px; background:rgba(255,255,255,.018); box-shadow:inset -1px 0 rgba(255,255,255,.045); transition:margin .18s ease,opacity .18s ease; }
        .caye-overlay-history.is-collapsed { margin-left:-220px; opacity:0; pointer-events:none; }
        .caye-overlay-new { width:100%; display:flex; align-items:center; gap:7px; padding:9px 10px; border:0; border-radius:8px; background:rgba(255,255,255,.05); color:#f4f4f5; cursor:pointer; text-align:left; font:600 11.5px inherit; transition:background .15s ease; }
        .caye-overlay-new:hover:not(:disabled) { background:rgba(255,255,255,.09); }
        .caye-overlay-search { display:flex; align-items:center; gap:6px; height:30px; margin:9px 1px 10px; padding:0 8px; border-radius:7px; color:#71717a; background:rgba(255,255,255,.035); }
        .caye-overlay-search input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:#f4f4f5; font:11.5px inherit; }
        .caye-overlay-search input::placeholder { color:#6e6e78; }
        .caye-overlay-history-scroll { min-height:0; flex:1; overflow-y:auto; }
        .caye-overlay-section-label { padding:5px 8px 4px; color:#707079; font:9.5px var(--font-mono); letter-spacing:.075em; text-transform:uppercase; }
        .caye-overlay-thread-row { position:relative; width:100%; display:flex; align-items:center; gap:6px; padding:6px 8px; overflow:hidden; border:0; border-radius:7px; background:transparent; color:#b1b1b9; cursor:pointer; text-align:left; font:500 11.5px inherit; white-space:nowrap; transition:background .14s ease,color .14s ease; }
        .caye-overlay-thread-row > span:last-child { overflow:hidden; text-overflow:ellipsis; }
        .caye-overlay-thread-row:hover { background:rgba(255,255,255,.05); color:#f4f4f5; }
        .caye-overlay-thread-row.is-active { background:rgba(78,190,206,.11); color:#f4f4f5; }
        .caye-overlay-thread-row.is-active::before { content:''; position:absolute; left:0; top:6px; bottom:6px; width:2px; border-radius:2px; background:${AQUA}; }
        .caye-overlay-thread-origin { width:5px; height:5px; flex:0 0 5px; border-radius:50%; background:${AQUA}; }
        .caye-overlay-empty-list { padding:6px 8px; color:#71717a; font-size:11px; }
        .caye-overlay-archive { margin-top:7px; padding:7px 8px 2px; border:0; background:transparent; color:#777780; cursor:pointer; text-align:left; font:10px var(--font-mono); }
        .caye-overlay-archive:hover { color:#bdbdc4; }
        .caye-overlay-live-heading { padding:4px 8px 9px; color:#e5e5e8; font:600 12px var(--font-display); }
        .caye-overlay-live-row { position:relative; width:100%; display:flex; flex-direction:column; gap:2px; padding:9px 8px; overflow:hidden; border:0; border-radius:8px; background:transparent; color:#c7c7ce; cursor:pointer; text-align:left; transition:background .14s ease,color .14s ease; }
        .caye-overlay-live-row:hover { background:rgba(255,255,255,.05); color:#f4f4f5; }
        .caye-overlay-live-row.is-active { background:rgba(78,190,206,.11); color:#f4f4f5; }
        .caye-overlay-live-row.is-active::before { content:''; position:absolute; left:0; top:8px; bottom:8px; width:2px; border-radius:2px; background:${AQUA}; }
        .caye-overlay-live-name { font-size:12px; font-weight:600; }
        .caye-overlay-live-meta { color:#767680; font:9.5px var(--font-mono); }
        .caye-overlay-main { min-width:0; flex:1; display:flex; flex-direction:column; }
        .caye-overlay-header { min-height:54px; display:flex; align-items:center; gap:9px; padding:10px clamp(16px,3vw,30px); }
        .caye-overlay-brand { min-width:0; display:flex; align-items:center; gap:8px; }
        .caye-overlay-brand-copy { min-width:0; display:flex; flex-direction:column; gap:1px; }
        .caye-overlay-brand-name { font:600 14px var(--font-display); color:#f4f4f5; }
        .caye-overlay-brand-workspace { overflow:hidden; color:#7b7b84; font-size:10.5px; text-overflow:ellipsis; white-space:nowrap; }
        .caye-overlay-mode-switcher { display:flex; align-items:center; gap:2px; margin-left:clamp(8px,2vw,22px); padding:3px; border-radius:9px; background:rgba(255,255,255,.035); box-shadow:inset 0 1px rgba(255,255,255,.04); }
        .caye-overlay-mode-button { border:0; border-radius:6px; padding:5px 8px; background:transparent; color:#85858e; cursor:pointer; font:600 10px var(--font-mono); letter-spacing:.025em; transition:background .14s ease,color .14s ease; }
        .caye-overlay-mode-button:hover { color:#d8d8dd; }
        .caye-overlay-mode-button.is-active { background:rgba(255,255,255,.085); color:#f4f4f5; box-shadow:0 1px 4px rgba(0,0,0,.2); }
        .caye-overlay-controls { margin-left:auto; display:flex; align-items:center; gap:3px; }
        .caye-overlay-icon-button { width:32px; height:32px; display:flex; align-items:center; justify-content:center; border:0; border-radius:8px; background:transparent; color:#85858e; cursor:pointer; transition:background .14s ease,color .14s ease; }
        .caye-overlay-icon-button:hover { background:rgba(255,255,255,.065); color:#f4f4f5; }
        .caye-overlay-conversation { min-height:0; flex:1; display:flex; }
        .caye-overlay-pane { min-width:0; min-height:0; flex:1; display:flex; }
        .caye-overlay-pane.is-hidden { display:none; }
        .caye-overlay-empty { min-height:0; flex:1; display:flex; align-items:center; justify-content:center; text-align:center; padding:36px; }
        .caye-overlay-empty-inner { max-width:330px; display:flex; flex-direction:column; align-items:center; gap:12px; }
        .caye-overlay-empty h2 { margin:0; color:#f4f4f5; font:600 20px var(--font-display); }
        .caye-overlay-empty p { margin:0; color:#85858e; font-size:13px; line-height:1.6; }
        .caye-overlay-empty-form { width:min(100%,420px); display:flex; align-items:center; gap:7px; margin-top:6px; padding:7px 7px 7px 13px; border-radius:15px; background:rgba(255,255,255,.06); box-shadow:inset 0 1px rgba(255,255,255,.05),0 10px 28px rgba(0,0,0,.18); }
        .caye-overlay-empty-form input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:#f4f4f5; font:13px inherit; }
        .caye-overlay-empty-form input::placeholder { color:#797982; }
        .caye-overlay-empty-send { width:30px; height:30px; flex:0 0 30px; display:flex; align-items:center; justify-content:center; border:0; border-radius:50%; background:${AQUA}; color:#0a0a0c; cursor:pointer; }
        .caye-overlay-empty-send:disabled { background:rgba(255,255,255,.09); color:#62626b; cursor:default; }
        .caye-overlay-mobile-history { display:none; }
        @media (max-width:720px) { .caye-overlay { padding:0; } .caye-overlay-backdrop { background:rgba(3,5,8,.82); backdrop-filter:none; } .caye-overlay-surface { width:100%; height:100%; min-height:0; border-radius:0; } .caye-overlay-history { position:absolute; z-index:2; inset:0 auto 0 0; width:min(82vw,300px); flex-basis:min(82vw,300px); box-shadow:14px 0 42px rgba(0,0,0,.48); transform:translateX(-105%); transition:transform .2s ease; } .caye-overlay-history.is-mobile-open { transform:translateX(0); } .caye-overlay-history.is-collapsed { margin-left:0; opacity:1; pointer-events:auto; } .caye-overlay-mobile-history { display:flex; } .caye-overlay-desktop-history { display:none; } .caye-overlay-mode-switcher { margin-left:auto; } }
        @media (prefers-reduced-motion:reduce) { .caye-overlay,.caye-overlay-surface,.caye-overlay-history { transition:none !important; } }
      `}</style>

      <div className="caye-overlay-backdrop" />
      <section className="caye-overlay-surface" role="dialog" aria-modal="true" aria-label="Caye Direct">
        <aside className={`caye-overlay-history ${historyOpen ? '' : 'is-collapsed'} ${mobileHistoryOpen ? 'is-mobile-open' : ''}`} aria-label={mode === 'chat' ? 'Caye Direct thread history' : 'Live conversations'}>
          {mode === 'chat' ? <>
            <button type="button" className="caye-overlay-new" onClick={() => createThread()} disabled={creating}>
              <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={AQUA} strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
              New conversation
            </button>
            <label className="caye-overlay-search"><svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" /></label>
            <div className="caye-overlay-history-scroll">
              {threads === null ? <div className="caye-overlay-empty-list"><CayeLoadingPulse size={13} /></div> : threads.length === 0 ? <div className="caye-overlay-empty-list">{showArchived ? 'No archived conversations.' : 'No conversations yet.'}</div> : groups.map((group) => <div key={group.label}><div className="caye-overlay-section-label">{group.label}</div>{group.items.map((thread) => <ThreadRow key={thread.id} thread={thread} active={thread.id === selectedId} onClick={() => selectThread(thread.id)} />)}</div>)}
            </div>
            <button type="button" className="caye-overlay-archive" onClick={() => { setShowArchived((current) => !current); setThreads(null); setSelectedId(null) }}>{showArchived ? '← Active conversations' : 'Archived conversations'}</button>
          </> : <>
            <div className="caye-overlay-live-heading">Live</div>
            <div className="caye-overlay-history-scroll">
              {operators === null ? <div className="caye-overlay-empty-list"><CayeLoadingPulse size={13} /></div> : operators.length === 0 ? <div className="caye-overlay-empty-list">No live conversations are available.</div> : operators.map((operator) => (
                <button key={operator.id} type="button" className={`caye-overlay-live-row ${operator.id === selectedOperatorId ? 'is-active' : ''}`} onClick={() => { setSelectedOperatorId(operator.id); setMobileHistoryOpen(false) }}>
                  <span className="caye-overlay-live-name">{liveOperatorLabels.get(operator.id) || 'Operator'}</span>
                  <span className="caye-overlay-live-meta">WhatsApp · Read only</span>
                </button>
              ))}
            </div>
          </>}
        </aside>

        <div className="caye-overlay-main">
          <header className="caye-overlay-header">
            <div className="caye-overlay-brand"><CayeMark size={20} /><div className="caye-overlay-brand-copy"><span className="caye-overlay-brand-name">Caye</span><span className="caye-overlay-brand-workspace">{workspaceName}</span></div></div>
            <div className="caye-overlay-mode-switcher" aria-label="Caye mode">
              <button type="button" className={`caye-overlay-mode-button ${mode === 'chat' ? 'is-active' : ''}`} onClick={() => selectMode('chat')}>Chat</button>
              <button type="button" className={`caye-overlay-mode-button ${mode === 'live' ? 'is-active' : ''}`} onClick={() => selectMode('live')}>Live</button>
            </div>
            <div className="caye-overlay-controls">
              <button type="button" className="caye-overlay-icon-button caye-overlay-mobile-history" aria-label="Open conversation history" onClick={() => setMobileHistoryOpen((current) => !current)}><svg aria-hidden width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
              <button type="button" className="caye-overlay-icon-button caye-overlay-desktop-history" aria-label={historyOpen ? 'Hide conversation history' : 'Show conversation history'} onClick={() => setHistoryOpen((current) => !current)}><svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 4v16" /></svg></button>
              <button type="button" className="caye-overlay-icon-button" aria-label="Close Caye" title="Close Caye (Esc)" onClick={onClose}><svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
            </div>
          </header>
          <div className="caye-overlay-conversation">
            <div className={`caye-overlay-pane ${mode !== 'chat' ? 'is-hidden' : ''}`} aria-hidden={mode !== 'chat'}>
              {selected ? <CayeDirectThread key={selected.id} mode="thread" workspaceId={workspaceId} threadId={selected.id} threadTitle={selected.title} compactHeader autoFocusComposer={open && mode === 'chat'} composerVisible={mode === 'chat'} scrollToLatest={open && mode === 'chat'} onThreadMeta={(meta) => updateThreadMeta(selected.id, meta)} onArchive={() => archiveThread(selected.id)} initialMessage={pendingInitialThreadId === selected.id ? pendingMessage : null} onInitialMessageSent={() => { setPendingInitialThreadId(null); setPendingMessage(null); onInitialMessageSent?.() }} /> : <div className="caye-overlay-empty">{threads === null ? <CayeLoadingPulse size={18} /> : <div className="caye-overlay-empty-inner"><CayeMark size={34} /><h2>How can I help?</h2><p>Ask about the business, a decision, or anything Caye is working on.</p><form className="caye-overlay-empty-form" onSubmit={(event) => { event.preventDefault(); startFromEmptyState() }}><input ref={emptyInputRef} value={emptyDraft} onChange={(event) => setEmptyDraft(event.target.value)} placeholder="Ask Caye anything…" aria-label="Ask Caye anything" /><button className="caye-overlay-empty-send" type="submit" disabled={!emptyDraft.trim() || creating} aria-label="Send"><svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg></button></form></div>}</div>}
            </div>
            <div className={`caye-overlay-pane ${mode !== 'live' ? 'is-hidden' : ''}`} aria-hidden={mode !== 'live'}>
              {selectedOperator ? <CayeDirectThread key={selectedOperator.id} mode="operator" workspaceId={workspaceId} operatorId={selectedOperator.id} operatorLabel={liveOperatorLabels.get(selectedOperator.id) || 'Operator'} scrollToLatest={open && mode === 'live'} /> : <div className="caye-overlay-empty">{operators === null ? <CayeLoadingPulse size={18} /> : <div className="caye-overlay-empty-inner"><CayeMark size={34} /><h2>Live conversations</h2><p>Select a person to view their read-only WhatsApp conversation with Caye.</p></div>}</div>}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
