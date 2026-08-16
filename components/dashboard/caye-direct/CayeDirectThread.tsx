'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { CayeMark } from '@/components/brand/CayeMark'
import { CayePresence } from '@/components/caye-presence/CayePresence'
import { FormattedReplyText } from '@/components/ui/FormattedReplyText'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
import { CayeComposerSurface } from '@/components/dashboard/founder-home/AskCayeComposer'
import { emitStale, ALL_TOPICS } from '@/lib/founder-freshness'

const NEAR_BOTTOM_PX = 96
const TEXTAREA_MAX_H = 220
const GLASS = { backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' } as const

type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed' | 'not_sent' | null

interface OperatorMessage {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  created_at: string
  wa_delivery_status?: DeliveryStatus
  wa_delivery_error?: string | null
  /** Present only on thread-mode responses — see app/api/founder/caye-direct/threads/[id]/route.ts. */
  origin?: 'whatsapp' | 'dashboard' | 'demo'
  operator_name?: string | null
  operator_role?: string | null
}

// Only outbound messages carry these — inbound is what the operator sent
// TO Caye, and there's nothing of ours to confirm delivery on. A null
// status (rather than missing) means the row has no real WhatsApp send
// behind it at all (demo roleplay turns, the founder's own typed messages
// from this same dashboard, log-only escalation closing notes) — not a
// failure, just not applicable, so it renders nothing rather than an icon.
// 'not_sent' is different from null: it means a send WAS relevant here but
// was deliberately skipped (e.g. a scan cron declining because the
// operator's 24h window is closed) — that must stay visibly distinct from
// "nothing to report" or a message the operator never actually saw reads
// as delivered commentary. See 20260805_operator_messages_not_sent_status.sql.
function DeliveryStatusIcon({ status, error }: { status: DeliveryStatus; error?: string | null }) {
  if (!status) return null

  if (status === 'failed' || status === 'not_sent') {
    const title = status === 'not_sent' ? (error ?? 'Not sent') : error ? `Not delivered — ${error}` : 'Not delivered'
    return (
      <span title={title} style={{ display: 'inline-flex', color: '#f59e0b' }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="13" />
          <line x1="12" y1="16.5" x2="12" y2="16.51" />
        </svg>
      </span>
    )
  }

  const doubleTick = status === 'delivered' || status === 'read'
  const color = status === 'read' ? '#4EBECE' : '#71717a'
  const label = status === 'sent' ? 'Sent' : status === 'delivered' ? 'Delivered' : 'Read'

  return (
    <span title={label} style={{ display: 'inline-flex', color }}>
      <svg width={doubleTick ? 15 : 11} height="11" viewBox={doubleTick ? '0 0 30 24' : '0 0 24 24'} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="1 13 7 19 17 5" />
        {doubleTick && <polyline points="9 13 15 19 25 5" />}
      </svg>
    </span>
  )
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

// Hover-revealed rather than always-visible — a Copy control sitting under
// every single bubble at full opacity would be more visual noise than the
// thread itself. `active` (hovered) keeps the layout slot reserved via
// opacity/pointerEvents instead of conditional mounting, so nothing shifts
// when it appears. Stays visible through `copied` even after the mouse
// leaves, so the "Copied" confirmation isn't cut off mid-flash.
function CopyButton({
  onCopy, active, copied, align,
}: {
  onCopy: () => void
  active: boolean
  copied: boolean
  align: 'flex-start' | 'flex-end'
}) {
  const visible = active || copied
  return (
    // The parent (content column) isn't a flex container, so alignSelf on
    // the button itself would be a no-op — a plain block/inline element
    // always sits at the container's left edge regardless. Wrapping in an
    // explicit flex row with justifyContent is what actually moves it to
    // the right for the operator's own (right-aligned) messages, same
    // technique the meta/timestamp row above it already uses.
    <div style={{ display: 'flex', justifyContent: align, marginTop: 3 }}>
      <button
        type="button"
        onClick={onCopy}
        title={copied ? 'Copied' : 'Copy message'}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '2px 6px', border: 'none', borderRadius: 6,
          background: 'transparent', cursor: 'pointer',
          color: copied ? '#4EBECE' : '#71717a',
          fontSize: 9.5, fontFamily: 'var(--font-mono)',
          opacity: visible ? 1 : 0,
          pointerEvents: visible ? 'auto' : 'none',
          transition: 'opacity 0.12s ease, color 0.12s ease',
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

type GroupPos = 'single' | 'first' | 'middle' | 'last'

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, yesterday)) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function bubbleRadius(isCaye: boolean, pos: GroupPos): string {
  const R = 16
  const tail = 4
  if (pos === 'first' || pos === 'middle') return `${R}px`
  return isCaye ? `${R}px ${R}px ${R}px ${tail}px` : `${R}px ${R}px ${tail}px ${R}px`
}

function DateDivider({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 2px' }}>
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
      <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', letterSpacing: '0.12em', color: '#52525b', textTransform: 'uppercase', flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
    </div>
  )
}

function DemoDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '15px 0 4px' }}>
      <div style={{ flex: 1, height: 1, background: 'rgba(78,190,206,0.18)' }} />
      <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.1em', color: '#72cfd9', textTransform: 'uppercase', flexShrink: 0 }}>
        Demo preview
      </span>
      <div style={{ flex: 1, height: 1, background: 'rgba(78,190,206,0.18)' }} />
    </div>
  )
}

// Shaped like a real incoming Caye message (sender label, then avatar +
// content at the same left edge and marginTop as a 'single'-position
// reply — see the actual message row below) so swapping this out for
// FormattedReplyText once the turn resolves doesn't shift anything.
// The glow behind the mark and the warm/gold "thinking" tone both reuse
// CayePresence's established language (STATE_PARAMS / CayePresenceFallback)
// rather than inventing a new one for this single spot.
function CayeWorkingIndicator() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignSelf: 'flex-start', maxWidth: '82%', animation: 'caye-msg-in 0.25s ease-out' }}>
      <div className="caye-direct-sender">Caye</div>
      <div
        role="status"
        aria-live="polite"
        style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 11 }}
      >
        <span className="caye-working-mark">
          <span aria-hidden className="caye-working-glow" />
          <CayeMark size={18} />
        </span>
        <span className="caye-working-label">Thinking</span>
        <span className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
          Caye is thinking
        </span>
      </div>
    </div>
  )
}

function MessageSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {[
        { w: '58%', caye: true },
        { w: '38%', caye: true },
        { w: '46%', caye: false },
      ].map((row, i) => (
        <div key={i} style={{
          alignSelf: row.caye ? 'flex-start' : 'flex-end',
          width: row.w, maxWidth: '70%', height: 34, borderRadius: 16,
          background: 'rgba(255,255,255,0.05)',
          animation: 'caye-skeleton-pulse 1.4s ease-in-out infinite',
          animationDelay: `${i * 0.12}s`,
        }} />
      ))}
    </div>
  )
}

function EmptyState({ label, readOnly }: { label: string; readOnly: boolean }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: '0 30px' }}>
      <CayePresence state="idle" size="small" interactive={false} />
      <div>
        <div style={{ fontSize: 14, fontFamily: 'var(--font-display)', fontWeight: 600, color: '#f4f4f5' }}>
          {readOnly ? `No history with ${label} yet` : 'Say hello to Caye'}
        </div>
        <p style={{ fontSize: 12.5, color: '#71717a', lineHeight: 1.55, marginTop: 6, maxWidth: 260 }}>
          {readOnly
            ? `Nothing to show yet — this fills in once ${label} texts Caye's back-office number.`
            : "This is the same agent that runs your back office over WhatsApp. Ask her anything about the business below."}
        </p>
      </div>
    </div>
  )
}

// In-flight agent turns, keyed by a caller-supplied string (thread id or
// operator id) rather than state/ref/context. Switching Direct threads or
// workspaces remounts this subtree, and per the note that used to live
// here, even a layout-level context resets on that navigation — a module-
// scope Map is the only thing that survives it, so a returning thread can
// re-attach to its own still-running turn instead of orphaning the fetch
// (the typing indicator disappearing was the symptom; a reply landing with
// no listener was the actual bug). Clears on hard reload, which is fine —
// by then the reply is already in the DB and the next mount's fetch picks
// it up.
const inFlightRuns = new Map<string, Promise<void>>()

interface ThreadModeProps {
  mode: 'thread'
  workspaceId: string
  threadId: string
  threadTitle: string | null
  /** Sidebar (CayeDirect.tsx) wants to know when the title lands so it can
   *  resort/relabel without a full thread-list refetch. */
  onThreadMeta?: (meta: { title: string | null }) => void
  /** Fired after a successful archive PATCH — parent removes it from the
   *  active list and clears selection. Archiving doesn't delete anything;
   *  sending a new message into an archived thread un-archives it (see
   *  the POST handler), so this is a visibility toggle, not a destroy. */
  onArchive?: () => void
  initialMessage?: string | null
  onInitialMessageSent?: () => void
  /** Lets the global overlay hand keyboard focus to its one canonical
   * composer as soon as it is summoned. */
  autoFocusComposer?: boolean
  /** The overlay owns the brand/close header, so this leaves only the
   * thread title and archive affordance in a quiet, compact row. */
  compactHeader?: boolean
  /** Chat remains mounted while Live is open so its draft and scroll position
   * survive a mode switch. The actual composer is omitted while hidden. */
  composerVisible?: boolean
  /** True only while this transcript is visible in an open overlay. It makes
   * the initial jump happen after a hidden pane receives real dimensions. */
  scrollToLatest?: boolean
}

interface OperatorModeProps {
  mode: 'operator'
  workspaceId: string
  operatorId: number
  operatorLabel: string
  /** In the main operator view, returns to the remembered Direct thread and
   * places this read-only transcript alongside it. Navigation only; no
   * operator message or Direct thread is created by this action. */
  onOpenSideBySide?: () => void
  /** Present only when this instance is the secondary, pinned transcript. */
  onCloseSideBySide?: () => void
  scrollToLatest?: boolean
}

type Props = ThreadModeProps | OperatorModeProps

// Web front end for the same back-office agent (lib/caye-agent, mode:
// 'back-office') operators already text over WhatsApp — same
// caye_operator_messages table, same tools, same trust level.
//
// Two modes, one component (2026-08-13 redesign):
//   'thread'   — a founder Caye Direct topic thread. Read/write. Backed by
//                /api/founder/caye-direct/threads/:id.
//   'operator' — read-only observability into one business operator's raw
//                WhatsApp history with Caye (Max, Mrs. Max). Backed by the
//                legacy /api/founder/caye-direct route. ALWAYS read-only —
//                there is no write path for this mode; the founder's own
//                authoring surface is 'thread' mode.
export default function CayeDirectThread(props: Props) {
  const { mode, workspaceId } = props
  const readOnly = mode === 'operator'
  const runKey = mode === 'thread' ? `thread:${props.threadId}` : `op:${workspaceId}:${props.operatorId}`
  const headerLabel = mode === 'thread' ? (props.threadTitle || 'New conversation') : props.operatorLabel

  const [messages, setMessages] = useState<OperatorMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  // Seeded from the registry rather than plain `false` so a thread that
  // remounts onto a running turn shows the typing indicator (and keeps the
  // composer disabled) from its very first render, with no flicker.
  const [sending, setSending] = useState(() => inFlightRuns.has(runKey))
  const [showJump, setShowJump] = useState(false)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [composerFocused, setComposerFocused] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)

  async function handleCopy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard permission denied/unavailable — nothing to escalate to
      // the operator over a copy button, just skip the "Copied" feedback.
      return
    }
    setCopiedKey(key)
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500)
  }

  async function handleArchive() {
    if (mode !== 'thread') return
    const { session } = await getSession()
    if (!session) return
    await fetch(`/api/founder/caye-direct/threads/${props.threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ workspaceId, status: 'archived' }),
    })
    props.onArchive?.()
  }

  // Returns the thread rather than setting it, so callers keep control of
  // their own cancellation and loading state — the initial load wants the
  // skeleton, the re-attach below explicitly does not.
  const fetchMessages = useCallback(async (): Promise<OperatorMessage[] | null> => {
    const { session } = await getSession()
    if (!session) return null
    const url = mode === 'thread'
      ? `/api/founder/caye-direct/threads/${props.threadId}?workspaceId=${workspaceId}`
      : `/api/founder/caye-direct?workspaceId=${workspaceId}&operatorId=${props.operatorId}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } })
    const json = await res.json()
    if (!res.ok) return null
    if (mode === 'thread' && json.thread) {
      props.onThreadMeta?.({ title: json.thread.title ?? null })
    }
    const transcript = (json.messages as OperatorMessage[]) ?? []
    if (mode !== 'operator') return transcript
    const demo = ((json.demoMessages as Array<{ role: 'guest' | 'caye'; body: string; created_at: string }> | undefined) ?? [])
      .map((message, index): OperatorMessage => ({
        id: `demo-${index}-${message.created_at}`,
        direction: message.role === 'caye' ? 'outbound' : 'inbound',
        body: message.body,
        created_at: message.created_at,
        origin: 'demo',
      }))
    return [...transcript, ...demo]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, workspaceId, mode === 'thread' ? props.threadId : props.operatorId])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const msgs = await fetchMessages()
      if (cancelled) return
      if (msgs) setMessages(msgs)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [fetchMessages])

  // Re-attach to a turn left running by an earlier mount (see inFlightRuns).
  // Refetches the thread on settle instead of appending the resolved reply:
  // the turn can finish while the initial history load is still in flight,
  // in which case that load already returned the reply and appending would
  // show it twice. Refetching is idempotent either way.
  useEffect(() => {
    const run = inFlightRuns.get(runKey)
    if (!run) return
    let cancelled = false
    run.then(async () => {
      const msgs = await fetchMessages()
      if (cancelled) return
      if (msgs) setMessages(msgs)
      setSending(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, fetchMessages])

  // Jump to the bottom once history is both loaded and visible. Live and
  // Chat stay mounted behind one another so their state survives switching;
  // a hidden pane has no useful viewport height, so scrolling on `loading`
  // alone can incorrectly leave it at the top when it becomes active.
  useEffect(() => {
    if (loading || props.scrollToLatest === false) return
    const frame = requestAnimationFrame(() => {
      const scroll = scrollRef.current
      if (!scroll) return
      scroll.scrollTo({ top: scroll.scrollHeight })
      atBottomRef.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [loading, props.scrollToLatest])

  // New messages auto-scroll only if the founder was already at the
  // bottom (mirrors the "don't yank the reader around" convention of
  // real chat apps) — otherwise surface the jump-to-latest pill.
  useEffect(() => {
    if (loading) return
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    } else {
      setShowJump(true)
    }
  }, [messages, loading])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_H)}px`
  }, [input])

  useEffect(() => {
    if (mode !== 'thread' || !props.autoFocusComposer) return
    textareaRef.current?.focus()
  }, [mode, mode === 'thread' ? props.autoFocusComposer : false])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    atBottomRef.current = nearBottom
    if (nearBottom) setShowJump(false)
  }

  function jumpToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    atBottomRef.current = true
    setShowJump(false)
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending || readOnly || mode !== 'thread') return

    setSending(true)
    setInput('')
    atBottomRef.current = true

    const optimistic: OperatorMessage = {
      id: `pending-${Date.now()}`,
      direction: 'inbound',
      body: trimmed,
      created_at: new Date().toISOString(),
      origin: 'dashboard',
      operator_role: 'founder',
    }
    setMessages((prev) => [...prev, optimistic])

    // The whole round trip lives in a registered promise, not in this
    // component, so switching threads/workspaces mid-turn doesn't orphan
    // it — a remounted thread picks it back up from inFlightRuns. Errors
    // are swallowed rather than thrown: this promise is awaited by any
    // number of remounts, and the message is already persisted
    // server-side, so a refetch recovers the thread regardless.
    const key = runKey
    const threadId = props.threadId
    const run = (async () => {
      try {
        const { session } = await getSession()
        if (!session) return
        const res = await fetch(`/api/founder/caye-direct/threads/${threadId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ workspaceId, message: trimmed }),
        })
        const json = await res.json()
        if (res.ok && json.replyText) {
          setMessages((prev) => [...prev, {
            id: `reply-${Date.now()}`,
            direction: 'outbound',
            body: json.replyText,
            created_at: new Date().toISOString(),
          }])
        }
        // A settled turn is the console's single biggest source of
        // silently-stale panels: Caye writes leads, drafts, bookings and
        // contacts as tool calls, and until now told only this thread
        // about it — the rest of the console kept showing pre-turn state
        // until a full page reload. Emitted inside the run promise rather
        // than in send()'s finally so it fires once per turn no matter how
        // many mounts are awaiting it, and still fires if this component
        // unmounted mid-turn (the whole point of inFlightRuns).
        if (res.ok) {
          emitStale(workspaceId, ALL_TOPICS)
          // Title generation happens server-side after the first reply —
          // one more fetch picks up the new title without polling.
          const msgs = await fetchMessages()
          if (msgs) setMessages(msgs)
        }
      } catch {
        // Nothing to surface here — see above.
      }
    })()
    inFlightRuns.set(key, run)

    try {
      await run
    } finally {
      // Runs even if this component unmounted mid-turn: the async function
      // isn't tied to the React tree, so the entry is always cleaned up.
      inFlightRuns.delete(key)
      setSending(false)
    }
  }

  // Fires the composer-supplied opener once history has settled — waiting
  // on `loading` rather than mount avoids racing the initial fetchMessages
  // call above (sending before history loads would land the optimistic
  // bubble, then have it overwritten by the fetch that follows).
  useEffect(() => {
    if (mode !== 'thread') return
    if (loading || !props.initialMessage) return
    send(props.initialMessage)
    props.onInitialMessageSent?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, mode === 'thread' ? props.initialMessage : null])

  // Build render items: a date divider whenever the calendar day changes,
  // and a group position per message so consecutive messages from the
  // same side draw as one visually joined stack (tail only on the last).
  const items: Array<
    | { kind: 'divider'; key: string; label: string }
    | { kind: 'demo-divider'; key: string }
    | { kind: 'message'; key: string; message: OperatorMessage; pos: GroupPos }
  > = []
  messages.forEach((m, i) => {
    const prev = messages[i - 1]
    const next = messages[i + 1]
    const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString()
    if (newDay) items.push({ kind: 'divider', key: `d-${m.id}`, label: dayLabel(m.created_at) })
    if (m.origin === 'demo' && prev?.origin !== 'demo') items.push({ kind: 'demo-divider', key: `demo-${m.id}` })

    const groupedWithPrev = !newDay && !!prev && prev.direction === m.direction
    const groupedWithNext = !!next && next.direction === m.direction &&
      new Date(next.created_at).toDateString() === new Date(m.created_at).toDateString()
    const pos: GroupPos = groupedWithPrev && groupedWithNext ? 'middle'
      : groupedWithPrev ? 'last'
      : groupedWithNext ? 'first'
      : 'single'
    items.push({ kind: 'message', key: m.id, message: m, pos })
  })

  return (
    <div className="caye-direct-thread" style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0, color: '#f4f4f5' }}>
      <style>{`
        @keyframes caye-msg-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes caye-skeleton-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        .caye-direct-scroll::-webkit-scrollbar { width: 6px; }
        .caye-direct-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
        .caye-direct-message-column { width:min(100%, 840px); min-height:100%; margin:0 auto; display:flex; flex-direction:column; gap:3px; }
        .caye-direct-thread-header { min-height:58px; padding:11px clamp(18px, 4vw, 48px); display:flex; align-items:center; gap:10px; background:rgba(10,10,12,.5); box-shadow:inset 0 -1px rgba(255,255,255,.04); }
        .caye-direct-thread-header.is-compact { min-height:43px; padding-top:4px; padding-bottom:5px; background:transparent; box-shadow:none; }
        .caye-direct-thread-heading { min-width:0; display:flex; flex-direction:column; gap:2px; }
        .caye-direct-thread-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 14px var(--font-display); color:#f4f4f5; }
        .caye-direct-thread-kicker { color:#777780; font:10px var(--font-mono); letter-spacing:.025em; }
        .caye-direct-thread-action { margin-left:auto; display:flex; align-items:center; gap:6px; padding:6px 8px; border:0; border-radius:7px; background:transparent; color:#87878f; cursor:pointer; font:10.5px var(--font-mono); white-space:nowrap; transition:background .14s ease,color .14s ease; }
        .caye-direct-thread-action:hover { background:rgba(255,255,255,.07); color:#f4f4f5; }
        .caye-direct-sender { margin:0 0 4px 26px; color:#8e8e96; font:10px var(--font-mono); letter-spacing:.025em; }
        .caye-direct-sender.is-you { margin:0 0 4px 0; text-align:right; }
        .caye-direct-composer-shell { width:min(100%, 840px); margin:0 auto; }
        .caye-direct-read-only-note { width:min(100%, 840px); margin:0 auto; color:#73737b; font-size:11.5px; text-align:center; line-height:1.45; }
        .caye-direct-scroll ::selection { background: rgba(78, 190, 206, 0.35); color: inherit; }
        .caye-direct-scroll ::-moz-selection { background: rgba(78, 190, 206, 0.35); color: inherit; }
        .caye-direct-textarea::placeholder { color: rgba(244,244,245,0.32); }
        .caye-working-mark { position: relative; width: 18px; height: 18px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .caye-working-glow {
          position: absolute; inset: -6px; border-radius: 50%;
          background: radial-gradient(circle, rgba(255,228,175,0.55), rgba(255,228,175,0) 72%);
          animation: caye-working-breathe 1.8s ease-in-out infinite;
        }
        .caye-working-label { font-size: 13px; line-height: 1; padding-bottom: 1px; color: #b8b8bf; }
        @supports (background-clip: text) or (-webkit-background-clip: text) {
          .caye-working-label {
            background: linear-gradient(90deg, #6f6f78 0%, #f4f4f5 45%, #6f6f78 90%);
            background-size: 200% 100%;
            -webkit-background-clip: text; background-clip: text;
            color: transparent; -webkit-text-fill-color: transparent;
            animation: caye-working-sweep 2.1s ease-in-out infinite;
          }
        }
        @keyframes caye-working-breathe {
          0%, 100% { opacity: 0.35; transform: scale(0.82); }
          50% { opacity: 0.85; transform: scale(1.05); }
        }
        @keyframes caye-working-sweep {
          0%, 100% { background-position: 200% 0; }
          50% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .caye-working-glow { animation: none; opacity: 0.55; }
          .caye-working-label { animation: none !important; background: none !important; color: #b8b8bf !important; -webkit-text-fill-color: unset !important; }
        }
        @media (max-width:600px) { .caye-direct-thread-header { padding-left:58px; } .caye-direct-thread-action { display:none; } }
      `}</style>

      <div className={`caye-direct-thread-header ${mode === 'thread' && props.compactHeader ? 'is-compact' : ''}`} style={{ ...GLASS }}>
        <div className="caye-direct-thread-heading">
          <div className="caye-direct-thread-title">{headerLabel}</div>
          <div className="caye-direct-thread-kicker">{mode === 'operator' ? 'WhatsApp · Read only' : 'Caye Direct'}</div>
        </div>
        {readOnly && <div style={{ marginLeft: 'auto' }}><Pill color="#71717a" label="Read only" dot={false} /></div>}
        {mode === 'operator' && props.onOpenSideBySide && (
          <button type="button" className="caye-direct-thread-action" onClick={props.onOpenSideBySide} title="Open beside your current Direct conversation">
            <svg aria-hidden width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>
            Side-by-side
          </button>
        )}
        {mode === 'operator' && props.onCloseSideBySide && (
          <button type="button" className="caye-direct-thread-action" onClick={props.onCloseSideBySide} title="Close side-by-side view">Close</button>
        )}
        {mode === 'thread' && (
          <button onClick={handleArchive} title="Archive — sending a new message here brings it back" className="caye-direct-thread-action">Archive</button>
        )}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="caye-direct-scroll"
          style={{ height: '100%', overflowY: 'auto', padding: '18px clamp(18px, 4vw, 48px) 24px' }}
        >
          <div className="caye-direct-message-column">
            {loading ? (
              <MessageSkeleton />
            ) : messages.length === 0 ? (
              <EmptyState label={headerLabel} readOnly={readOnly} />
            ) : (
              items.map((item) => {
              if (item.kind === 'divider') return <DateDivider key={item.key} label={item.label} />
              if (item.kind === 'demo-divider') return <DemoDivider key={item.key} />
              const { message: m, pos } = item
              const isCaye = m.direction === 'outbound'
              const showAvatar = isCaye && (pos === 'single' || pos === 'last')
              const showMeta = pos === 'single' || pos === 'last'
              const showSender = pos === 'first' || pos === 'single'
              // "Max · via WhatsApp" — only in thread mode, only for a
              // non-founder operator's message that arrived over WhatsApp
              // and got linked into this thread (relate_to_direct_thread).
              // Shown once per group, not on every bubble in a run. Never
              // shown for the founder's own dashboard-typed messages, and
              // never in operator mode (the whole pane is already one
              // operator's WhatsApp history — a per-bubble label would be
              // redundant noise there).
              const showOrigin = mode === 'thread' && !isCaye && m.origin === 'whatsapp' && m.operator_role !== 'founder' && (pos === 'first' || pos === 'single')
              return (
                <div key={item.key} style={{ display: 'flex', flexDirection: 'column', alignSelf: isCaye ? 'flex-start' : 'flex-end', maxWidth: '82%' }}>
                  {showSender && <div className={`caye-direct-sender ${isCaye ? '' : 'is-you'}`}>{isCaye ? 'Caye' : m.origin === 'demo' ? 'Demo guest' : mode === 'operator' ? headerLabel : 'You'}</div>}
                  {showOrigin && (
                    <div style={{
                      fontSize: 9.5, fontFamily: 'var(--font-mono)', color: '#71717a',
                      textAlign: 'right', marginBottom: 3, marginTop: pos === 'first' || pos === 'single' ? 11 : 0,
                    }}>
                      {m.operator_name || 'Operator'} · via WhatsApp
                    </div>
                  )}
                  <div
                    onMouseEnter={() => setHoveredKey(item.key)}
                    onMouseLeave={() => setHoveredKey((k) => (k === item.key ? null : k))}
                    style={{
                      display: 'flex', alignItems: 'flex-end', gap: 8,
                      flexDirection: isCaye ? 'row' : 'row-reverse',
                      marginTop: !showOrigin && (pos === 'first' || pos === 'single') ? 11 : 0,
                      animation: 'caye-msg-in 0.28s ease-out',
                    }}
                  >
                    {isCaye && (showAvatar ? <CayeMark size={18} /> : <div style={{ width: 18, flexShrink: 0 }} />)}
                    <div style={{ maxWidth: '100%' }}>
                      {isCaye ? (
                        // No box for Caye — her words sit in the open, so
                        // long replies stay easy to read instead of fighting
                        // a tinted container. Her mark (rendered alongside)
                        // is what identifies the sender, not a rule. The
                        // operator's own words keep the bubble, so the two
                        // voices still read as visually distinct.
                        <div style={{ padding: '1px 0' }}>
                          <FormattedReplyText text={m.body} style={{ fontSize: 14, lineHeight: 1.6, color: '#f4f4f5' }} />
                        </div>
                      ) : (
                        <div style={{
                          background: 'rgba(255,255,255,0.08)',
                          borderRadius: bubbleRadius(isCaye, pos), padding: '9px 12px',
                        }}>
                          <p style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: '#f4f4f5' }}>{m.body}</p>
                        </div>
                      )}
                      {showMeta && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          fontSize: 9.5, fontFamily: 'var(--font-mono)', color: '#52525b', marginTop: 4,
                          justifyContent: isCaye ? 'flex-start' : 'flex-end', padding: '0 2px',
                        }}>
                          {isCaye && <DeliveryStatusIcon status={m.wa_delivery_status ?? null} error={m.wa_delivery_error} />}
                          {formatDistanceToNow(m.created_at)}
                        </div>
                      )}
                      <CopyButton
                        onCopy={() => handleCopy(item.key, m.body)}
                        active={hoveredKey === item.key}
                        copied={copiedKey === item.key}
                        align={isCaye ? 'flex-start' : 'flex-end'}
                      />
                    </div>
                  </div>
                </div>
              )
              })
            )}
            {sending && <CayeWorkingIndicator />}
          </div>
        </div>

        {showJump && (
          <button
            onClick={jumpToBottom}
            style={{
              position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#0a0a0b',
              background: '#4EBECE', border: 'none', borderRadius: 999, padding: '6px 12px 6px 10px',
              cursor: 'pointer', boxShadow: '0 4px 16px -4px rgba(0,0,0,0.5)',
              animation: 'caye-msg-in 0.2s ease-out',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" />
            </svg>
            New messages
          </button>
        )}
      </div>

      {readOnly ? (
        <div style={{ padding: '11px 18px 13px', background: 'transparent' }}>
          <div className="caye-direct-read-only-note">{headerLabel} texts Caye directly on WhatsApp. You&apos;re viewing their conversation, not sending as either person.</div>
        </div>
      ) : props.composerVisible !== false ? (
        <div style={{ padding: '12px clamp(18px, 4vw, 48px) 16px', background: 'transparent', position: 'relative' }}>
          <form className="caye-direct-composer-shell" onSubmit={(e) => { e.preventDefault(); send(input) }}>
            <CayeComposerSurface active={composerFocused} maxWidth="100%" style={{ alignItems: 'flex-end' }}>
              <span style={{ display: 'flex', alignSelf: 'center', flexShrink: 0 }}><CayeMark size={20} /></span>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
                }}
                placeholder="Ask Caye anything…"
                disabled={sending}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                rows={1}
                className="caye-direct-textarea"
                style={{
                  flex: 1, resize: 'none', overflowY: 'auto',
                  maxHeight: TEXTAREA_MAX_H,
                  background: 'transparent', border: 'none',
                  padding: '6px 0', fontSize: 13.5, lineHeight: 1.5, color: '#f4f4f5',
                  outline: 'none', fontFamily: 'inherit',
                }}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                style={{
                  flexShrink: 0, width: 30, height: 30, borderRadius: '50%', border: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: sending || !input.trim() ? 'default' : 'pointer',
                  background: sending || !input.trim() ? 'rgba(255,255,255,0.06)' : 'linear-gradient(90deg, #4EBECE, #FFE4AF)',
                  opacity: sending || !input.trim() ? (composerFocused ? 0.7 : 0.45) : 1,
                  transition: 'background 0.15s ease, opacity 0.15s ease',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke={!input.trim() ? 'rgba(245,245,244,0.35)' : '#0a0a0b'}
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </CayeComposerSurface>
          </form>
        </div>
      ) : null}
    </div>
  )
}
