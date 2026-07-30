'use client'

import { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { CayeMark } from '@/components/brand/CayeMark'
import { FormattedReplyText } from '@/components/ui/FormattedReplyText'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
import { useFounderConversations, fetchConversationById, type ConversationSummary } from '@/lib/useFounderConversations'
import { useFreshness, useRevalidateOnFocus } from '@/lib/founder-freshness'

const GLASS = { backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' } as const

interface ThreadMessage {
  id: string
  sender_type: string
  content: string
  sent_at: string
  metadata?: { generated_by?: string; proposed_reply?: string } | null
  is_internal?: boolean
}

// hold_kinds whose auto-generated draft is safe to pre-fill into the
// compose box unattended — both are the same repeatable, policy-
// constrained outreach copy (outreach-script.md's opener/follow-up
// templates), not a founder judgment call like a general escalation.
const AUTO_FILL_HOLD_KINDS = new Set(['outreach_followup', 'outreach_first_touch'])

// Channels /api/messages/send doesn't dispatch for yet — matches its
// switch statement's default 422 case (lib SMS send never got wired to
// that endpoint, only inbound).
const SEND_UNSUPPORTED = new Set(['sms'])

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WA',
  email: 'Mail',
  instagram: 'IG',
  messenger: 'FB',
  sms: 'SMS',
}
const CHANNEL_COLOR: Record<string, string> = {
  whatsapp: '#22c55e',
  email: '#4EBECE',
  instagram: '#FFE4AF',
  messenger: '#4EBECE',
  sms: 'rgba(245,245,244,0.5)',
}

function TabPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
        fontSize: 11, fontWeight: 600,
        background: active ? '#f5f5f4' : hover ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.06)',
        color: active ? '#0a0a0b' : hover ? 'rgba(245,245,244,0.85)' : 'rgba(245,245,244,0.55)',
        transition: 'background 0.15s ease, color 0.15s ease',
      }}
    >
      {label}
    </button>
  )
}

function ConversationRow({ c, active, onClick }: { c: ConversationSummary; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  const label = CHANNEL_LABEL[c.channel_type] ?? c.channel_type
  const color = CHANNEL_COLOR[c.channel_type] ?? 'rgba(245,245,244,0.5)'
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
        background: active ? 'rgba(78,190,206,0.09)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        borderRadius: 10, padding: '10px 10px 10px 14px', marginBottom: 2,
        transition: 'background 0.12s ease',
      }}
    >
      {active && (
        <span aria-hidden style={{ position: 'absolute', left: 3, top: 8, bottom: 8, width: 2.5, borderRadius: 3, background: '#4EBECE' }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.customer_name || 'Unknown'}
        </span>
        <Pill color={color} label={label} dot={false} />
      </div>
      <p style={{
        fontSize: 11.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        color: c.human_agent_enabled ? 'rgba(251,113,133,0.85)' : 'rgba(245,245,244,0.4)',
      }}>
        {c.human_agent_enabled ? (c.human_agent_reason || 'Needs review') : c.last_message_preview}
      </p>
      {c.human_agent_enabled && (
        <div style={{ marginTop: 4 }}><Pill color="#fb7185" label="Needs review" /></div>
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
  /** True in the small grid-card layout (unexpanded dashboard tile) —
   *  hides the compose box there since a two-line textarea + send button
   *  doesn't fit that width/height without crowding the thread. The
   *  ExpandButton at FounderHome's card level is how the founder gets to
   *  the full view where sending actually makes sense. */
  compact?: boolean
}

// Search re-queries the server (it covers every conversation, not just
// whatever page is loaded), so it's debounced rather than firing on
// every keystroke.
const SEARCH_DEBOUNCE_MS = 300
// Pixels from the bottom of the list column at which the next page loads.
const LOAD_MORE_THRESHOLD_PX = 120

export default function CommandConversations({ workspaceId, selectedConversationId, onSent, compact = false }: Props) {
  const [tab, setTab] = useState<'all' | 'review'>('all')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [thread, setThread] = useState<{ customer_name: string | null; messages: ThreadMessage[] } | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const threadContainerRef = useRef<HTMLDivElement | null>(null)
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null)
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
  // The target conversation can be arbitrarily old, so it isn't assumed to
  // already be in the loaded page — fetch it directly and merge it in.
  useEffect(() => {
    if (!selectedConversationId) return
    let cancelled = false
    setActiveId(selectedConversationId)
    setTab('all')
    setQuery('')
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

  // `quiet` skips the loading flag so a background refresh swaps the
  // messages in place instead of collapsing the open thread to a skeleton
  // under whoever's reading it.
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

  // The open thread is stale for the same reasons the list is — Caye can
  // append to the conversation you're looking at (a drafted first touch, an
  // auto-reply) without this pane hearing about it.
  const refreshThread = useCallback(() => { loadThread(true) }, [loadThread])
  useFreshness(workspaceId, ['conversations'], refreshThread)
  useRevalidateOnFocus(refreshThread)

  const activeSummary = list.find((c) => c.id === activeId)

  // Auto-fill is scoped narrowly to AUTO_FILL_HOLD_KINDS — the repeatable,
  // policy-constrained cold-outreach cases (outreach-script.md's opener
  // and "one follow-up, low-pressure, then stop" templates) that are safe
  // to have sitting ready for a one-click send/edit. General holds/
  // escalations (a founder judgment call — the Gwyn/charity-partnership
  // case) still open empty on purpose: only "Draft with Caye" puts text
  // there, and only when explicitly asked for.
  //
  // This also stashes whatever's in the box for the conversation being
  // left (typed by hand or drafted) into draftsRef, and restores it if you
  // come back — so switching threads never silently wipes an in-progress
  // reply. A stashed value (including one you've edited down to empty
  // after auto-fill) always wins over re-deriving the auto-fill again.
  // replyText is read via closure rather than listed as a dependency
  // (it's the previous conversation's value at the moment this runs, which
  // is exactly what needs saving) — same pattern as ChannelsPanel's
  // one-time param-cleanup effect elsewhere in this codebase.
  useEffect(() => {
    const prevId = prevActiveIdRef.current
    if (prevId) draftsRef.current.set(prevId, replyText)

    if (!activeId) {
      setReplyText('')
    } else if (draftsRef.current.has(activeId)) {
      setReplyText(draftsRef.current.get(activeId) ?? '')
    } else {
      const entering = list.find((c) => c.id === activeId)
      const autoFill =
        entering?.human_agent_enabled && AUTO_FILL_HOLD_KINDS.has(entering.metadata?.hold_kind ?? '')
          ? entering.metadata?.proposed_reply ?? ''
          : ''
      setReplyText(autoFill)
    }
    setSendError(null)
    prevActiveIdRef.current = activeId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // Auto-grow the compose box to fit its content (up to a cap, then it
  // scrolls internally) instead of a fixed row count — a drafted nudge
  // can be 6+ lines and a static 2-row box was hiding most of it.
  const REPLY_MAX_HEIGHT = 220
  useLayoutEffect(() => {
    const el = replyTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, REPLY_MAX_HEIGHT)}px`
  }, [replyText])

  // On-demand draft, distinct from the auto-populated hold draft above —
  // this is for conversations with no proposed_reply already sitting there
  // (a normal thread, not a held escalation) where the founder wants a
  // starting point instead of writing from scratch. Only offered while the
  // box is empty so it can never silently clobber something being typed.
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
      if (activeId) draftsRef.current.delete(activeId)
      onSent?.()
      // /api/messages/send clears human_agent_enabled and updates the
      // preview server-side — patch the row in place rather than a full
      // list refetch so scroll position and the loaded page survive. If
      // that clears it out of the Review tab's filter, drop it locally
      // too instead of leaving it visible until the next refetch.
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

  // Scroll the thread container to the bottom whenever the thread
  // finishes loading or new messages arrive so the newest messages
  // are visible by default.
  useEffect(() => {
    if (threadLoading) return
    const el = threadContainerRef.current
    if (!el) return
    // small timeout to allow rendering to complete before measuring
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [threadLoading, thread?.messages?.length])

  return (
    <div style={{ height: '100%', display: 'flex', color: '#f5f5f4' }}>
      {/* ── List column ── */}
      <div style={{ width: '46%', background: 'rgba(255,255,255,0.015)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 16px 10px' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['all', 'review'] as const).map((t) => (
              <TabPill key={t} label={t === 'all' ? 'All chats' : `Review (${reviewCount})`} active={tab === t} onClick={() => setTab(t)} />
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search by name…"
            style={{
              width: '100%', background: 'rgba(255,255,255,0.05)',
              border: `1px solid ${searchFocused ? 'rgba(78,190,206,0.5)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#f5f5f4', outline: 'none',
              boxShadow: searchFocused ? '0 0 0 3px rgba(78,190,206,0.1)' : 'none',
              transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
            }}
          />
        </div>
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}
          onScroll={(e) => {
            const el = e.currentTarget
            if (!nextCursor || loadingMore) return
            if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD_PX) loadMore()
          }}
        >
          {listLoading && list.length === 0 ? (
            <div style={{ padding: '8px 10px' }}><CayeLoadingPulse size={14} /></div>
          ) : list.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'rgba(245,245,244,0.35)', padding: '8px 10px' }}>No conversations.</div>
          ) : (
            <>
              {list.map((c) => (
                <ConversationRow key={c.id} c={c} active={activeId === c.id} onClick={() => setActiveId(c.id)} />
              ))}
              {loadingMore && (
                <div style={{ padding: '8px 10px' }}><CayeLoadingPulse size={12} /></div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Thread detail — header stays pinned; only the message list
          scrolls, so landing scrolled-to-bottom never hides who/what
          channel this is (matches CayeDirectThread's pattern). ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {!activeSummary ? (
          <div style={{ padding: 16, fontSize: 13, color: 'rgba(245,245,244,0.35)' }}>Select a conversation.</div>
        ) : (
          <>
            <div style={{ padding: '14px 16px', flexShrink: 0, background: 'rgba(255,255,255,0.035)', ...GLASS }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{activeSummary.customer_name || 'Unknown'}</div>
              <div style={{ fontSize: 11, color: 'rgba(245,245,244,0.35)', marginTop: 2 }}>
                Channel: {CHANNEL_LABEL[activeSummary.channel_type] ?? activeSummary.channel_type}
              </div>
            </div>
            <div ref={threadContainerRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
            {threadLoading ? (
              <CayeLoadingPulse size={16} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(thread?.messages ?? []).map((m) => {
                  const isBusiness = m.sender_type === 'business'
                  const isCayeMsg = isBusiness && m.metadata?.generated_by === 'caye'

                  // Internal notes (escalation flags, held-message context)
                  // never went to the customer — they don't belong on
                  // either side of the thread as a "spoken" bubble. Full-
                  // width annotation card instead, so it can't be mistaken
                  // for something Caye actually sent.
                  if (m.is_internal) {
                    // proposed_reply intentionally not rendered here — the
                    // auto-generated hold draft still exists (it feeds the
                    // WhatsApp ping) but surfacing it in-thread just invited
                    // one-click-sending filler before actually deciding
                    // anything. "Draft with Caye" below is opt-in instead.
                    const noteBody = m.content.replace(/^\[[^\]]*\]\s*/, '')
                    return (
                      <div key={m.id} style={{
                        alignSelf: 'stretch', display: 'flex', gap: 8, alignItems: 'flex-start',
                        background: 'rgba(255,228,175,0.06)', border: '1px solid rgba(255,228,175,0.25)',
                        borderRadius: 10, padding: '8px 12px',
                      }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFE4AF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 3, flexShrink: 0 }}>
                          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
                        </svg>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.08em', color: '#FFE4AF', textTransform: 'uppercase', marginBottom: 2 }}>
                            Internal note — not sent to customer
                          </div>
                          <p style={{ fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', color: 'rgba(245,245,244,0.7)' }}>{noteBody}</p>
                          <span style={{ fontSize: 10, color: 'rgba(245,245,244,0.3)' }}>{formatDistanceToNow(m.sent_at)}</span>
                        </div>
                      </div>
                    )
                  }

                  // Same language as Caye Direct: her replies sit in the
                  // open with an accent rule and her mark, no box — a
                  // human's words (owner or customer) stay boxed. That
                  // keeps "who actually said this" unambiguous without
                  // adding a name/label to every line.
                  if (isCayeMsg) {
                    return (
                      <div key={m.id} style={{ alignSelf: 'flex-end', maxWidth: '80%', display: 'flex', alignItems: 'flex-start', gap: 6, flexDirection: 'row-reverse' }}>
                        <div style={{ paddingTop: 2, flexShrink: 0 }}><CayeMark size={14} /></div>
                        <div style={{ borderRight: '2px solid #4EBECE', padding: '1px 12px 1px 0', textAlign: 'left' }}>
                          <FormattedReplyText text={m.content} style={{ fontSize: 13.5, lineHeight: 1.5, color: '#f4f4f5' }} />
                          <span style={{ display: 'block', textAlign: 'right', fontSize: 10, color: 'rgba(245,245,244,0.35)', marginTop: 2 }}>{formatDistanceToNow(m.sent_at)}</span>
                        </div>
                      </div>
                    )
                  }

                  return (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: isBusiness ? 'flex-end' : 'flex-start',
                        maxWidth: '80%',
                        background: 'rgba(255,255,255,0.07)',
                        borderRadius: isBusiness ? '12px 3px 12px 12px' : '3px 12px 12px 12px',
                        padding: '8px 12px',
                      }}
                    >
                      <p style={{ fontSize: 13, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>{m.content}</p>
                      <span style={{ fontSize: 10, color: 'rgba(245,245,244,0.35)' }}>{formatDistanceToNow(m.sent_at)}</span>
                    </div>
                  )
                })}
              </div>
            )}
            </div>
            {!compact && !SEND_UNSUPPORTED.has(activeSummary.channel_type) && (
              <div style={{ flexShrink: 0, padding: 12, borderTop: '1px solid rgba(255,255,255,0.08)', ...GLASS }}>
                {sendError && (
                  <div style={{ fontSize: 11.5, color: '#fb7185', marginBottom: 6 }}>{sendError}</div>
                )}
                {!replyText.trim() && (
                  <button
                    onClick={handleDraft}
                    disabled={drafting}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6,
                      border: 'none', background: 'transparent', cursor: drafting ? 'default' : 'pointer',
                      padding: '2px 4px', fontSize: 11.5, fontWeight: 600,
                      color: drafting ? 'rgba(245,245,244,0.3)' : 'rgba(78,190,206,0.85)',
                    }}
                  >
                    {drafting ? <CayeLoadingPulse size={11} /> : <CayeMark size={12} />}
                    {drafting ? 'Drafting…' : 'Draft with Caye'}
                  </button>
                )}
                <div style={{
                  display: 'flex', alignItems: 'flex-end', gap: 8,
                  borderRadius: 20,
                  background: 'rgba(255,255,255,0.04)', padding: '8px 8px 8px 14px',
                }}>
                  <textarea
                    ref={replyTextareaRef}
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend() }
                    }}
                    placeholder={`Reply to ${activeSummary.customer_name || 'this conversation'}… (⌘/Ctrl+Enter to send)`}
                    rows={1}
                    disabled={sending}
                    style={{
                      flex: 1, resize: 'none', overflowY: 'auto',
                      maxHeight: REPLY_MAX_HEIGHT,
                      background: 'transparent', border: 'none',
                      padding: '6px 0', fontSize: 13.5, lineHeight: 1.5, color: '#f5f5f4',
                      outline: 'none', fontFamily: 'inherit',
                    }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={sending || !replyText.trim()}
                    title="Send (⌘/Ctrl+Enter)"
                    style={{
                      flexShrink: 0, width: 32, height: 32, borderRadius: '50%', border: 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: sending || !replyText.trim() ? 'default' : 'pointer',
                      background: sending || !replyText.trim() ? 'rgba(255,255,255,0.08)' : '#4EBECE',
                      transition: 'background 0.15s ease',
                    }}
                  >
                    {sending ? (
                      <CayeLoadingPulse size={12} />
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                        stroke={!replyText.trim() ? 'rgba(245,245,244,0.35)' : '#0a0a0b'}
                        strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
