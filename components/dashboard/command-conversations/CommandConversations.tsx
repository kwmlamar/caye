'use client'

import { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { useFounderIdentity } from '@/lib/useFounderIdentity'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { CayeMark } from '@/components/brand/CayeMark'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { CayeComposerSurface } from '@/components/dashboard/founder-home/AskCayeComposer'
import { useFounderConversations, fetchConversationById, type ConversationSummary } from '@/lib/useFounderConversations'
import { useFreshness, useRevalidateOnFocus } from '@/lib/founder-freshness'
import { conversationNeedsFounder } from '@/lib/hold-kinds-shared'
import { AQUA, TEXT, TEXT_QUIET, rowDivider } from '@/components/dashboard/surface'
import { channelLabel } from './channel-meta'
import ConversationRow from './ConversationRow'
import CayeHandoff from './CayeHandoff'
import Message, { type ThreadMessage } from './Message'

// Channels /api/messages/send doesn't dispatch for yet — matches its
// switch statement's default 422 case (lib SMS send never got wired to
// that endpoint, only inbound).
const SEND_UNSUPPORTED = new Set(['sms'])

// hold_kinds whose auto-generated draft is safe to pre-fill into the
// compose box unattended — both are the same repeatable, policy-
// constrained outreach copy (outreach-script.md's opener/follow-up
// templates), not a founder judgment call like a general escalation.
const AUTO_FILL_HOLD_KINDS = new Set(['outreach_followup', 'outreach_first_touch'])

// /api/founder/draft-reply hard-rejects everything but email today (see
// its own doc comment) — showing "Draft with Caye" on a WhatsApp/IG/FB
// thread would just produce a 400. Gated here rather than left for the
// founder to discover by clicking it.
const DRAFT_SUPPORTED_CHANNELS = new Set(['email'])

function isEscalationNote(m: ThreadMessage): boolean {
  return !!m.is_internal && m.content.startsWith('[Caye escalation')
}
function escalationNoteBody(m: ThreadMessage): string {
  return m.content.replace(/^\[[^\]]*\]\s*/, '')
}

function InternalNoteMarker({ isEscalation, at }: { isEscalation: boolean; at: string }) {
  return (
    <div style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: TEXT_QUIET, padding: '2px 0' }}>
      <span aria-hidden style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(255,255,255,0.22)' }} />
      {isEscalation ? 'Escalated' : 'Internal note'} · {formatDistanceToNow(at)}
    </div>
  )
}

function SearchIcon({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

// Real, truthfully-derivable states only — 'all' vs 'review' matches
// exactly what useFounderConversations/the backend filter supports. No
// "waiting on customer" / "paused" tab: nothing in the data model
// distinguishes those from "Caye handling" today.
function FilterPill({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11.5, fontWeight: 600,
        background: active ? 'rgba(255,255,255,0.1)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        color: active ? TEXT : TEXT_QUIET,
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {label}
      {typeof count === 'number' && count > 0 && (
        <span aria-hidden style={{
          fontSize: 10, fontWeight: 700, color: '#FFE4AF', background: 'rgba(255,228,175,0.16)',
          borderRadius: 999, padding: '1px 6px',
        }}>
          {count}
        </span>
      )}
    </button>
  )
}

interface Props {
  workspaceId: string
  /** Set by a sibling panel (CommandCalendar's booking click-through) to
   *  jump this panel to a specific conversation without owning its
   *  internal selection/search/tab state. */
  selectedConversationId?: string | null
  /** Called after a manual send succeeds so the parent's overview stats
   *  (pending escalation count, etc.) can refetch — this panel patches
   *  its own conversation list locally via useFounderConversations. */
  onSent?: () => void
}

// Search re-queries the server (it covers every conversation, not just
// whatever page is loaded), so it's debounced rather than firing on
// every keystroke.
const SEARCH_DEBOUNCE_MS = 300
// Pixels from the bottom of the list column at which the next page loads.
const LOAD_MORE_THRESHOLD_PX = 120

// List column width — draggable via the divider, remembered across
// sessions. Default favors the thread (the thing you're actually
// reading) over the list.
const LIST_WIDTH_KEY = 'cayeConversationsListWidthPct'
const LIST_WIDTH_DEFAULT = 28
const LIST_WIDTH_MIN = 20
const LIST_WIDTH_MAX = 55

function readStoredListWidth(): number {
  if (typeof window === 'undefined') return LIST_WIDTH_DEFAULT
  const stored = Number(window.localStorage.getItem(LIST_WIDTH_KEY))
  return stored >= LIST_WIDTH_MIN && stored <= LIST_WIDTH_MAX ? stored : LIST_WIDTH_DEFAULT
}

function ColumnDivider({ onMouseDown, active }: { onMouseDown: (e: React.MouseEvent) => void; active: boolean }) {
  const [hover, setHover] = useState(false)
  const lit = active || hover
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize"
      style={{ width: 9, flexShrink: 0, cursor: 'col-resize', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div style={{
        width: lit ? 2 : 1, height: '100%', background: lit ? AQUA : 'rgba(255,255,255,0.06)',
        transition: active ? 'none' : 'background 0.15s ease, width 0.15s ease',
      }} />
      <div style={{
        position: 'absolute', width: 3, height: 22, borderRadius: 2,
        background: lit ? 'rgba(78,190,206,0.9)' : 'rgba(255,255,255,0.14)',
        transition: active ? 'none' : 'background 0.15s ease',
      }} />
    </div>
  )
}

export default function CommandConversations({ workspaceId, selectedConversationId, onSent }: Props) {
  const { firstName } = useFounderIdentity()
  const founderLabel = firstName ?? 'You'
  const isNarrow = useMediaQuery('(max-width: 760px)')
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list')

  const [tab, setTab] = useState<'all' | 'review'>('all')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [thread, setThread] = useState<{ customer_name: string | null; customer_id: string | null; messages: ThreadMessage[] } | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [draftSource, setDraftSource] = useState<'caye' | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [recovery, setRecovery] = useState<{ originalMessageId: string } | null>(null)
  const [recoveryState, setRecoveryState] = useState<'idle' | 'running' | 'sent' | 'blocked' | 'delivery_unknown' | 'error'>('idle')
  const threadContainerRef = useRef<HTMLDivElement | null>(null)
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [listWidthPct, setListWidthPct] = useState(readStoredListWidth)
  const [resizing, setResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const listWidthRef = useRef(listWidthPct)
  listWidthRef.current = listWidthPct
  // In-progress compose text per conversation, keyed by conversation id —
  // switching threads and coming back used to wipe whatever was typed or
  // drafted, since replyText was a single flat value reset on every switch.
  const draftsRef = useRef<Map<string, string>>(new Map())
  const prevActiveIdRef = useRef<string | null>(null)
  // Only auto-select the first row once — otherwise every background
  // refetch (tab switch, search, loadMore) would yank the founder back to
  // the top row mid-read.
  const hasSetInitialActiveRef = useRef(false)
  // Only the newest thread fetch may write — a background refresh must not
  // land on top of the thread you switched to while it was in flight.
  const threadRequestIdRef = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const { items: list, nextCursor, reviewCount, loading: listLoading, loadingMore, loadMore, upsert, remove } =
    useFounderConversations(workspaceId, tab, debouncedQuery)

  // A booking click in CommandCalendar routes here — jump straight to that
  // customer's thread, clearing any tab/search filter that would hide it.
  useEffect(() => {
    if (!selectedConversationId) return
    let cancelled = false
    setActiveId(selectedConversationId)
    setTab('all')
    setQuery('')
    setMobileView('thread')
    fetchConversationById(workspaceId, selectedConversationId).then((conv) => {
      if (!cancelled && conv) upsert(conv)
    })
    return () => { cancelled = true }
  }, [selectedConversationId, workspaceId, upsert])

  // Default to the first conversation once the initial page loads.
  useEffect(() => {
    if (hasSetInitialActiveRef.current || selectedConversationId || list.length === 0) return
    hasSetInitialActiveRef.current = true
    setActiveId(list[0].id)
  }, [list, selectedConversationId])

  const loadThread = useCallback(async (quiet = false) => {
    if (!activeId) return
    const requestId = ++threadRequestIdRef.current
    if (!quiet) setThreadLoading(true)
    const { session } = await getSession()
    if (!session) { if (!quiet) setThreadLoading(false); return }
    try {
      const res = await fetch(`/api/founder/conversation-messages?workspaceId=${workspaceId}&conversationId=${activeId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (requestId === threadRequestIdRef.current && res.ok) setThread(json)
    } finally {
      if (requestId === threadRequestIdRef.current && !quiet) setThreadLoading(false)
    }
  }, [activeId, workspaceId])

  useEffect(() => {
    if (!activeId) { setThread(null); return }
    loadThread()
  }, [activeId, loadThread])

  const refreshThread = useCallback(() => { loadThread(true) }, [loadThread])
  useFreshness(workspaceId, ['conversations'], refreshThread)
  useRevalidateOnFocus(refreshThread)

  const activeSummary = list.find((c) => c.id === activeId)

  useEffect(() => {
    let cancelled = false
    setRecovery(null); setRecoveryState('idle')
    if (!activeId) return
    ;(async () => {
      const { session } = await getSession()
      if (!session) return
      const params = new URLSearchParams({ workspaceId, conversationId: activeId })
      const res = await fetch(`/api/sales/recover-stale-hold?${params}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await res.json() as { eligible?: boolean; originalMessageId?: string }
      if (!cancelled && res.ok && json.eligible && json.originalMessageId) setRecovery({ originalMessageId: json.originalMessageId })
    })()
    return () => { cancelled = true }
  }, [activeId, workspaceId])

  async function handleRecovery() {
    if (!activeId || !recovery || recoveryState === 'running') return
    setRecoveryState('running')
    const { session } = await getSession()
    if (!session) { setRecoveryState('error'); return }
    try {
      const res = await fetch('/api/sales/recover-stale-hold', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ conversationId: activeId, originalMessageId: recovery.originalMessageId }) })
      const json = await res.json() as { status?: 'sent' | 'blocked' | 'delivery_unknown' }
      setRecoveryState(json.status === 'sent' || json.status === 'blocked' || json.status === 'delivery_unknown' ? json.status : 'error')
      if (json.status === 'sent') { loadThread(true); fetchConversationById(workspaceId, activeId).then(c => c && upsert(c)); onSent?.() }
    } catch { setRecoveryState('error') }
  }

  function handleSelectConversation(id: string) {
    setActiveId(id)
    setMobileView('thread')
  }

  // Caye's handoff card fades out (rather than just vanishing) the moment
  // an open escalation clears — but only when that transition happens
  // WHILE the founder is looking at it. An already-resolved escalation
  // loaded fresh (page load, conversation switch) never plays the exit
  // animation; it just renders as a quiet historical marker instead.
  const [handoffState, setHandoffState] = useState<'hidden' | 'open' | 'resolving'>('hidden')
  useEffect(() => { setHandoffState('hidden') }, [activeId])
  useEffect(() => {
    const nowOpen = !!activeSummary && conversationNeedsFounder(activeSummary)
    setHandoffState((s) => {
      if (nowOpen) return 'open'
      return s === 'open' ? 'resolving' : 'hidden'
    })
  }, [activeSummary?.human_agent_enabled])
  useEffect(() => {
    if (handoffState !== 'resolving') return
    const t = setTimeout(() => setHandoffState('hidden'), 380)
    return () => clearTimeout(t)
  }, [handoffState])

  // Auto-fill is scoped narrowly to AUTO_FILL_HOLD_KINDS — the repeatable,
  // policy-constrained cold-outreach cases that are safe to have sitting
  // ready for a one-click send/edit. General holds/escalations still open
  // empty on purpose: only "Draft with Caye" puts text there.
  useEffect(() => {
    const prevId = prevActiveIdRef.current
    if (prevId) draftsRef.current.set(prevId, replyText)

    if (!activeId) {
      setReplyText('')
      setDraftSource(null)
    } else if (draftsRef.current.has(activeId)) {
      setReplyText(draftsRef.current.get(activeId) ?? '')
      setDraftSource(null)
    } else {
      const entering = list.find((c) => c.id === activeId)
      const isAutoFill = entering?.human_agent_enabled && AUTO_FILL_HOLD_KINDS.has(entering.metadata?.hold_kind ?? '')
      setReplyText(isAutoFill ? entering?.metadata?.proposed_reply ?? '' : '')
      setDraftSource(isAutoFill ? 'caye' : null)
    }
    setSendError(null)
    prevActiveIdRef.current = activeId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const REPLY_MAX_HEIGHT = 220
  useLayoutEffect(() => {
    const el = replyTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, REPLY_MAX_HEIGHT)}px`
  }, [replyText])

  async function handleDraft() {
    if (!activeId || drafting) return
    setDrafting(true)
    setSendError(null)
    try {
      const { session } = await getSession()
      if (!session) { setSendError('Not signed in'); return }
      const res = await fetch('/api/founder/draft-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ conversationId: activeId }),
      })
      const json = await res.json() as { draft?: string; error?: string }
      if (!res.ok || !json.draft) {
        setSendError(json.error ?? 'Failed to generate a draft')
        return
      }
      setReplyText(json.draft)
      setDraftSource('caye')
    } catch {
      setSendError('Failed to generate a draft')
    } finally {
      setDrafting(false)
    }
  }

  async function handleSend() {
    const text = replyText.trim()
    if (!activeId || !text || sending) return
    setSending(true)
    setSendError(null)
    try {
      const { session } = await getSession()
      if (!session) { setSendError('Not signed in'); return }
      const res = await fetch('/api/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ conversation_id: activeId, content: text }),
      })
      const json = await res.json() as { success?: boolean; error?: string; message?: { id: string; sent_at: string } }
      if (!res.ok || !json.success) {
        setSendError(json.error ?? 'Failed to send')
        return
      }
      setThread((prev) => prev ? {
        ...prev,
        messages: [...prev.messages, {
          id: json.message?.id ?? `local_${Date.now()}`,
          sender_type: 'business',
          content: text,
          sent_at: json.message?.sent_at ?? new Date().toISOString(),
          is_internal: false,
        }],
      } : prev)
      setReplyText('')
      setDraftSource(null)
      if (activeId) draftsRef.current.delete(activeId)
      onSent?.()
      // /api/messages/send clears human_agent_enabled and resolves the
      // open escalation server-side — this is the real "hand back to
      // Caye" action; there's no separate takeover/handback endpoint to
      // wire a second button to.
      const sentId = activeId
      fetchConversationById(workspaceId, sentId).then((conv) => {
        if (!conv) return
        if (tab === 'review' && !conv.human_agent_enabled) {
          remove(sentId)
        } else {
          upsert(conv)
        }
      })
    } catch {
      setSendError('Failed to send')
    } finally {
      setSending(false)
    }
  }

  function focusComposer() {
    replyTextareaRef.current?.focus()
  }

  useEffect(() => {
    if (threadLoading) return
    const el = threadContainerRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [threadLoading, thread?.messages?.length, mobileView])

  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setResizing(true)
  }, [])

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setListWidthPct(Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, pct)))
    }
    const onUp = () => {
      setResizing(false)
      window.localStorage.setItem(LIST_WIDTH_KEY, String(listWidthRef.current))
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  const showList = !isNarrow || mobileView === 'list'
  const showThread = !isNarrow || mobileView === 'thread'
  const messages = thread?.messages ?? []
  const lastEscalationIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (isEscalationNote(messages[i])) return i
    return -1
  })()
  const customerLabel = activeSummary?.customer_name || activeSummary?.customer_id || thread?.customer_name || 'the customer'

  return (
    <div ref={containerRef} style={{ flex: 1, minWidth: 0, width: '100%', height: '100%', display: 'flex', color: TEXT }}>
      <style>{`
        @keyframes caye-resolve-out { to { opacity: 0; transform: scale(0.98); } }
      `}</style>

      {/* ── List — Inbox rail. No outer card, no border; separation from
          the thread is the vertical divider (or nothing at all on
          mobile, where only one pane shows at a time). ── */}
      {showList && (
      <div style={{ width: isNarrow ? '100%' : `${listWidthPct}%`, flexShrink: 0, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '16px 14px 10px' }}>
          <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-display)', marginBottom: 10 }}>Inbox</div>
          <div style={{ display: 'flex', gap: 2, marginBottom: 10 }}>
            <FilterPill label="All" active={tab === 'all'} onClick={() => setTab('all')} />
            <FilterPill label="Needs you" count={reviewCount} active={tab === 'review'} onClick={() => setTab('review')} />
          </div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 11, display: 'flex', pointerEvents: 'none' }}>
              <SearchIcon color={searchFocused ? AQUA : 'rgba(245,245,244,0.3)'} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search conversations…"
              aria-label="Search conversations"
              style={{
                width: '100%', background: searchFocused ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.028)',
                border: 'none', borderRadius: 999, padding: '7px 10px 7px 30px', fontSize: 12.5, color: TEXT, outline: 'none',
                transition: 'background 0.15s ease',
              }}
            />
          </div>
        </div>
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '0 6px 8px' }}
          onScroll={(e) => {
            const el = e.currentTarget
            if (!nextCursor || loadingMore) return
            if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD_PX) loadMore()
          }}
        >
          {listLoading && list.length === 0 ? (
            <div style={{ padding: '8px 10px' }}><CayeLoadingPulse size={14} /></div>
          ) : list.length === 0 ? (
            tab === 'review' ? (
              // Calm, not broken — nothing needing review is the good
              // outcome, not an empty state to apologize for.
              <div style={{ padding: '24px 14px', textAlign: 'center' }}>
                <p style={{ fontSize: 12.5, color: TEXT_QUIET, lineHeight: 1.6, margin: 0 }}>
                  Caye has everything handled.<br />No conversations need you.
                </p>
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: TEXT_QUIET, padding: '8px 10px' }}>No conversations yet.</div>
            )
          ) : (
            <>
              {list.map((c) => (
                <ConversationRow key={c.id} c={c} active={activeId === c.id} onClick={() => handleSelectConversation(c.id)} />
              ))}
              {loadingMore && <div style={{ padding: '8px 10px' }}><CayeLoadingPulse size={12} /></div>}
            </>
          )}
        </div>
      </div>
      )}

      {!isNarrow && <ColumnDivider onMouseDown={handleDividerMouseDown} active={resizing} />}

      {/* ── Thread ── */}
      {showThread && (
      <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!activeSummary ? (
          <div style={{ padding: 16, fontSize: 13, color: TEXT_QUIET }}>Select a conversation.</div>
        ) : (
          <>
            <div style={{ padding: '13px 18px', flexShrink: 0, borderBottom: rowDivider, display: 'flex', alignItems: 'center', gap: 10 }}>
              {isNarrow && (
                <button
                  onClick={() => setMobileView('list')}
                  aria-label="Back to conversation list"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', padding: 0, flexShrink: 0, color: TEXT_QUIET }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {activeSummary.customer_name || activeSummary.customer_id || 'Unknown'}
                </div>
                <div style={{ fontSize: 11.5, color: TEXT_QUIET, marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{channelLabel(activeSummary.channel_type)}</span>
                  {activeSummary.customer_name && activeSummary.customer_id && (
                    <>
                      <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeSummary.customer_id}</span>
                    </>
                  )}
                </div>
              </div>
              {conversationNeedsFounder(activeSummary) ? (
                <span style={{ fontSize: 11, fontWeight: 600, color: '#FFE4AF', flexShrink: 0 }}>Needs you</span>
              ) : (
                <span style={{ fontSize: 11, color: TEXT_QUIET, flexShrink: 0 }}>Caye handling</span>
              )}
              {recovery && recoveryState === 'idle' && (
                <button onClick={handleRecovery} style={{ border: '1px solid rgba(78,190,206,0.5)', borderRadius: 999, background: 'rgba(78,190,206,0.12)', color: '#b9f4fb', padding: '6px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
                  Let Caye retry this reply
                </button>
              )}
              {recoveryState !== 'idle' && (
                <span style={{ fontSize: 11, color: recoveryState === 'sent' ? AQUA : recoveryState === 'delivery_unknown' ? '#FFE4AF' : '#fb7185', flexShrink: 0 }}>
                  {recoveryState === 'running' ? 'Caye is replying…' : recoveryState === 'sent' ? 'Caye replied' : recoveryState === 'delivery_unknown' ? 'Delivery needs review' : recoveryState === 'blocked' ? 'Recovery blocked' : 'Recovery failed'}
                </span>
              )}
            </div>

            <div ref={threadContainerRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 18px' }}>
              {threadLoading ? (
                <CayeLoadingPulse size={16} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {messages.map((m, i) => {
                    if (m.is_internal) {
                      if (i === lastEscalationIdx && (handoffState === 'open' || handoffState === 'resolving')) {
                        return (
                          <CayeHandoff
                            key={m.id}
                            note={escalationNoteBody(m)}
                            category={(m.metadata as { category?: string } | null)?.category ?? null}
                            routeTo={(m.metadata as { route_to?: string } | null)?.route_to ?? null}
                            at={m.sent_at}
                            onReply={focusComposer}
                            resolved={handoffState === 'resolving'}
                          />
                        )
                      }
                      return <InternalNoteMarker key={m.id} isEscalation={isEscalationNote(m)} at={m.sent_at} />
                    }
                    return (
                      <Message
                        key={m.id}
                        message={m}
                        channelType={activeSummary.channel_type}
                        customerLabel={customerLabel}
                        founderLabel={founderLabel}
                      />
                    )
                  })}
                </div>
              )}
            </div>

            {!SEND_UNSUPPORTED.has(activeSummary.channel_type) && (
              <div style={{ padding: '12px 18px 16px', flexShrink: 0 }}>
                {sendError && <div style={{ fontSize: 11.5, color: '#fb7185', marginBottom: 6 }}>{sendError}</div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, minHeight: 16 }}>
                  {!replyText.trim() && DRAFT_SUPPORTED_CHANNELS.has(activeSummary.channel_type) && (
                    <button
                      onClick={handleDraft}
                      disabled={drafting}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 5,
                        border: 'none', background: 'transparent', cursor: drafting ? 'default' : 'pointer',
                        padding: 0, fontSize: 11.5, fontWeight: 600,
                        color: drafting ? TEXT_QUIET : AQUA,
                      }}
                    >
                      {drafting ? <CayeLoadingPulse size={11} /> : <CayeMark size={12} />}
                      {drafting ? 'Drafting…' : 'Ask Caye to draft'}
                    </button>
                  )}
                  {draftSource === 'caye' && replyText.trim() && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: TEXT_QUIET }}>
                      <CayeMark size={11} /> Drafted with Caye
                    </span>
                  )}
                </div>
                <ReplyBox
                  replyTextareaRef={replyTextareaRef}
                  replyText={replyText}
                  onChange={(v) => { setReplyText(v); setDraftSource(null) }}
                  onSend={handleSend}
                  sending={sending}
                  maxHeight={REPLY_MAX_HEIGHT}
                  customerLabel={customerLabel}
                />
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  )
}

function ReplyBox({
  replyTextareaRef, replyText, onChange, onSend, sending, maxHeight, customerLabel,
}: {
  replyTextareaRef: React.RefObject<HTMLTextAreaElement | null>
  replyText: string
  onChange: (v: string) => void
  onSend: () => void
  sending: boolean
  maxHeight: number
  customerLabel: string
}) {
  const [focused, setFocused] = useState(false)
  const ready = !sending && !!replyText.trim()
  return (
    // Same surface CayeDirectThread's own composer uses (CayeComposerSurface)
    // — the two should read as the same control, not lookalikes maintained
    // separately.
    <CayeComposerSurface
      active={focused}
      maxWidth="100%"
      style={{
        alignItems: 'flex-end',
        borderRadius: 20,
        background: focused ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.035)',
        border: `1px solid ${focused ? 'rgba(78,190,206,0.28)' : 'rgba(255,255,255,0.07)'}`,
        boxShadow: focused
          ? '0 1px 0 rgba(255,255,255,0.04) inset, 0 0 14px -4px rgba(78,190,206,0.18), 0 10px 24px -12px rgba(0,0,0,0.5)'
          : '0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 18px -10px rgba(0,0,0,0.45)',
        transition: 'background 0.18s ease, border-color 0.2s ease, box-shadow 0.22s ease',
      }}
    >
      <textarea
        ref={replyTextareaRef}
        value={replyText}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend() }
        }}
        placeholder={`Reply to ${customerLabel}…`}
        aria-label={`Reply to ${customerLabel}`}
        rows={1}
        disabled={sending}
        style={{
          flex: 1, resize: 'none', overflowY: 'auto', maxHeight,
          background: 'transparent', border: 'none',
          padding: '6px 0', fontSize: 13.5, lineHeight: 1.5, color: TEXT,
          outline: 'none', fontFamily: 'inherit',
        }}
      />
      <button
        onClick={onSend}
        disabled={!ready}
        title="Send (⌘/Ctrl+Enter)"
        aria-label="Send reply"
        style={{
          flexShrink: 0, width: 34, height: 34, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: ready ? 'rgba(78,190,206,0.16)' : 'rgba(255,255,255,0.09)',
          border: `1px solid ${ready ? 'rgba(78,190,206,0.5)' : 'rgba(255,255,255,0.14)'}`,
          cursor: ready ? 'pointer' : 'default',
          transition: 'background 0.15s ease, border-color 0.15s ease, transform 0.08s ease',
        }}
      >
        {sending ? <CayeLoadingPulse size={12} /> : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke={ready ? '#4EBECE' : 'rgba(244,244,245,0.65)'}
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
          </svg>
        )}
      </button>
    </CayeComposerSurface>
  )
}
