'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { CayeMark } from '@/components/brand/CayeMark'
import { FormattedReplyText } from '@/components/ui/FormattedReplyText'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
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

// Local slash commands, handled client-side in send() rather than sent to
// the agent — add new ones here as they come up.
interface SlashCommand { name: string; description: string }
const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: "Wipe this conversation — Caye won't remember it after" },
]

// Turns that are still running, keyed by workspace+operator. Deliberately
// module scope rather than state, a ref, or context.
//
// Clicking another workspace navigates to a new /dashboard/[workspaceId]
// route, which remounts this whole subtree — and per the note in
// FounderHome.tsx, even hoisting to a layout-level context still reset on
// param change, so there is no in-tree place to keep this. Losing it on
// remount had two effects: the typing indicator vanished, and (the real
// bug) the in-flight fetch was orphaned, so when Caye's reply finally
// landed nothing was listening and the thread never updated — it looked
// like she'd stopped mid-thought.
//
// The turn itself was always fine. Nothing aborts it (no AbortController
// in this path), so the request runs to completion and the POST handler
// persists the reply either way; it just had no live listener.
//
// A module-scope Map lives in the JS module registry, not the component
// tree, so remounts can't touch it and a returning thread can find its own
// still-running turn. It clears on hard reload, which is the right
// behaviour: by then the reply is in the DB and the history fetch on mount
// picks it up.
const inFlightRuns = new Map<string, Promise<void>>()

function runKey(workspaceId: string, operatorId: number): string {
  return `${workspaceId}:${operatorId}`
}

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

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, alignSelf: 'flex-start', animation: 'caye-msg-in 0.25s ease-out' }}>
      <CayeMark size={20} />
      <div
        className="caye-typing-bubble"
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          borderRadius: '16px 16px 16px 4px', padding: '12px 14px',
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 5, height: 5, borderRadius: '50%',
              background: 'linear-gradient(135deg, #9EE3E5, #4EBECE)',
              animation: 'caye-typing-dot 1.2s ease-in-out infinite',
              animationDelay: `${i * 0.16}s`,
            }}
          />
        ))}
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

function CommandMenu({
  commands, activeIndex, onHover, onSelect,
}: {
  commands: SlashCommand[]
  activeIndex: number
  onHover: (i: number) => void
  onSelect: (cmd: SlashCommand) => void
}) {
  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: 8,
        background: 'rgba(24,24,27,0.97)', ...GLASS,
        borderRadius: 12, overflow: 'hidden',
        boxShadow: '0 16px 36px -10px rgba(0,0,0,0.65)',
        animation: 'caye-msg-in 0.15s ease-out',
      }}
    >
      {commands.map((cmd, i) => (
        <div
          key={cmd.name}
          onMouseDown={(e) => { e.preventDefault(); onSelect(cmd) }}
          onMouseEnter={() => onHover(i)}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 10, padding: '9px 12px',
            background: i === activeIndex ? 'rgba(78,190,206,0.14)' : 'transparent',
            cursor: 'pointer', transition: 'background 0.1s ease',
          }}
        >
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600,
            color: i === activeIndex ? '#4EBECE' : '#f4f4f5', flexShrink: 0,
          }}>
            /{cmd.name}
          </span>
          <span style={{ fontSize: 11.5, color: '#71717a' }}>{cmd.description}</span>
        </div>
      ))}
    </div>
  )
}

function EmptyState({ operatorLabel, readOnly }: { operatorLabel: string; readOnly: boolean }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: '0 30px' }}>
      <div style={{ position: 'relative' }}>
        <div aria-hidden style={{ position: 'absolute', inset: -10, borderRadius: '50%', background: 'radial-gradient(circle, rgba(78,190,206,0.18), transparent 70%)' }} />
        <CayeMark size={40} />
      </div>
      <div>
        <div style={{ fontSize: 14, fontFamily: 'var(--font-display)', fontWeight: 600, color: '#f4f4f5' }}>
          {readOnly ? `No history with ${operatorLabel} yet` : 'Say hello to Caye'}
        </div>
        <p style={{ fontSize: 12.5, color: '#71717a', lineHeight: 1.55, marginTop: 6, maxWidth: 260 }}>
          {readOnly
            ? `Nothing to show yet — this fills in once ${operatorLabel} texts Caye's back-office number.`
            : "This is the same agent that runs your back office over WhatsApp. Send a message below to get going."}
        </p>
      </div>
    </div>
  )
}

interface Props {
  workspaceId: string
  operatorId: number
  operatorLabel: string
  /** True for any operator other than the founder — their real replies
   *  happen over their own WhatsApp, not this dashboard, so there's
   *  nothing to type here; it's a monitoring view of their thread. */
  readOnly: boolean
  /** Set by the dashboard's "Ask Caye anything" composer (TalkToCaye) —
   *  sent once history has loaded, then the parent is told to clear it via
   *  onInitialMessageSent. The parent owns clearing, not this component,
   *  so a re-render with the same string can't fire a second send. */
  initialMessage?: string | null
  onInitialMessageSent?: () => void
}

// Web front end for the same back-office agent operators already text
// over WhatsApp (lib/caye-agent, mode: 'back-office') — same
// history (caye_operator_messages), same tools, same trust level.
// Scoped to one operator's conversation at a time (see CayeDirect.tsx for
// the operator switcher) so multiple people sharing a workspace's
// back-office channel don't get merged into one confusing stream.
export default function CayeDirectThread({ workspaceId, operatorId, operatorLabel, readOnly, initialMessage, onInitialMessageSent }: Props) {
  const [messages, setMessages] = useState<OperatorMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  // Seeded from the registry rather than plain `false` so a thread that
  // remounts onto a running turn shows the typing indicator (and keeps the
  // composer disabled) from its very first render, with no flicker.
  const [sending, setSending] = useState(() => inFlightRuns.has(runKey(workspaceId, operatorId)))
  const [showJump, setShowJump] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)

  // Still typing the "/command" token itself (no space yet) — filter the
  // registry against it and show the picker while there's a match.
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1).toLowerCase() : null
  const filteredCommands = slashQuery !== null
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery))
    : []
  const showCommandMenu = filteredCommands.length > 0
  const activeCommandIndex = Math.min(commandIndex, filteredCommands.length - 1)

  function selectCommand(cmd: SlashCommand) {
    setInput(`/${cmd.name} `)
    setCommandIndex(0)
    textareaRef.current?.focus()
  }

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

  // Returns the thread rather than setting it, so callers keep control of
  // their own cancellation and loading state — the initial load wants the
  // skeleton, the re-attach below explicitly does not.
  const fetchMessages = useCallback(async (): Promise<OperatorMessage[] | null> => {
    const { session } = await getSession()
    if (!session) return null
    const res = await fetch(`/api/founder/caye-direct?workspaceId=${workspaceId}&operatorId=${operatorId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const json = await res.json()
    return res.ok ? (json.messages as OperatorMessage[]) : null
  }, [workspaceId, operatorId])

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
    const run = inFlightRuns.get(runKey(workspaceId, operatorId))
    if (!run) return
    let cancelled = false
    run.then(async () => {
      const msgs = await fetchMessages()
      if (cancelled) return
      if (msgs) setMessages(msgs)
      setSending(false)
    })
    return () => { cancelled = true }
  }, [workspaceId, operatorId, fetchMessages])

  // Jump to the bottom instantly once history has finished loading —
  // no scroll animation on first paint.
  useEffect(() => {
    if (loading) return
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    atBottomRef.current = true
  }, [loading])

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

  async function handleClear() {
    if (clearing) return
    setClearing(true)
    setMessages([])
    const { session } = await getSession()
    if (session) {
      await fetch(`/api/founder/caye-direct?workspaceId=${workspaceId}&operatorId=${operatorId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
    }
    setClearing(false)
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending || readOnly) return

    if (trimmed.toLowerCase() === '/clear') {
      setInput('')
      await handleClear()
      return
    }

    setSending(true)
    setInput('')
    atBottomRef.current = true

    const optimistic: OperatorMessage = {
      id: `pending-${Date.now()}`,
      direction: 'inbound',
      body: trimmed,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])

    // The whole round trip lives in a registered promise, not in this
    // component, so switching workspaces mid-turn doesn't orphan it — a
    // remounted thread picks it back up from inFlightRuns. Errors are
    // swallowed rather than thrown: this promise is awaited by any number
    // of remounts, and the operator's message is already persisted
    // server-side, so a refetch recovers the thread regardless.
    const key = runKey(workspaceId, operatorId)
    const run = (async () => {
      try {
        const { session } = await getSession()
        if (!session) return
        const res = await fetch('/api/founder/caye-direct', {
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
        if (res.ok) emitStale(workspaceId, ALL_TOPICS)
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
    if (loading || !initialMessage) return
    send(initialMessage)
    onInitialMessageSent?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, initialMessage])

  // Build render items: a date divider whenever the calendar day changes,
  // and a group position per message so consecutive messages from the
  // same side draw as one visually joined stack (tail only on the last).
  const items: Array<
    | { kind: 'divider'; key: string; label: string }
    | { kind: 'message'; key: string; message: OperatorMessage; pos: GroupPos }
  > = []
  messages.forEach((m, i) => {
    const prev = messages[i - 1]
    const next = messages[i + 1]
    const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString()
    if (newDay) items.push({ kind: 'divider', key: `d-${m.id}`, label: dayLabel(m.created_at) })

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0, color: '#f4f4f5' }}>
      <style>{`
        @keyframes caye-typing-dot {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0) scale(0.85); }
          30% { opacity: 1; transform: translateY(-3px) scale(1); }
        }
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
        .caye-direct-scroll ::selection { background: rgba(78, 190, 206, 0.35); color: inherit; }
        .caye-direct-scroll ::-moz-selection { background: rgba(78, 190, 206, 0.35); color: inherit; }
        .caye-direct-textarea::placeholder { color: rgba(244,244,245,0.32); }
        .caye-typing-bubble {
          background: linear-gradient(155deg, rgba(7,102,163,0.20), rgba(7,102,163,0.09));
          box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 6px 16px -8px rgba(7,102,163,0.5);
        }
      `}</style>

      <div style={{ padding: '14px 40px 14px 16px', display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.035)', ...GLASS }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{operatorLabel}</span>
        <span style={{ fontSize: 11, color: '#52525b' }}>↔ Caye</span>
        {readOnly && (
          <div style={{ marginLeft: 'auto' }}><Pill color="#71717a" label="Read-only · replies via WhatsApp" dot={false} /></div>
        )}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="caye-direct-scroll"
          style={{ height: '100%', overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 3 }}
        >
          {loading ? (
            <MessageSkeleton />
          ) : messages.length === 0 ? (
            <EmptyState operatorLabel={operatorLabel} readOnly={readOnly} />
          ) : (
            items.map((item) => {
              if (item.kind === 'divider') return <DateDivider key={item.key} label={item.label} />
              const { message: m, pos } = item
              const isCaye = m.direction === 'outbound'
              const showAvatar = isCaye && (pos === 'single' || pos === 'last')
              const showMeta = pos === 'single' || pos === 'last'
              return (
                <div
                  key={item.key}
                  onMouseEnter={() => setHoveredKey(item.key)}
                  onMouseLeave={() => setHoveredKey((k) => (k === item.key ? null : k))}
                  style={{
                    display: 'flex', alignItems: 'flex-end', gap: 8,
                    alignSelf: isCaye ? 'flex-start' : 'flex-end',
                    flexDirection: isCaye ? 'row' : 'row-reverse',
                    maxWidth: '82%',
                    marginTop: pos === 'first' || pos === 'single' ? 11 : 0,
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
              )
            })
          )}
          {sending && <div style={{ marginTop: 11 }}><TypingIndicator /></div>}
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
        <div style={{ padding: '12px 16px', fontSize: 11.5, color: '#52525b', textAlign: 'center', background: 'rgba(255,255,255,0.035)', ...GLASS }}>
          {operatorLabel} texts Caye directly from their own WhatsApp — you can watch here, not send as them.
        </div>
      ) : (
        <div style={{ padding: 14, background: 'rgba(255,255,255,0.035)', position: 'relative', ...GLASS }}>
          {showCommandMenu && (
            <CommandMenu
              commands={filteredCommands}
              activeIndex={activeCommandIndex}
              onHover={setCommandIndex}
              onSelect={selectCommand}
            />
          )}
          <form onSubmit={(e) => { e.preventDefault(); send(input) }}>
            <div style={{
              display: 'flex', alignItems: 'flex-end', gap: 8,
              borderRadius: 20,
              background: 'rgba(255,255,255,0.04)', padding: '8px 8px 8px 14px',
            }}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => { setInput(e.target.value); setCommandIndex(0) }}
                onKeyDown={(e) => {
                  if (showCommandMenu) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setCommandIndex((i) => Math.min(i + 1, filteredCommands.length - 1)); return }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setCommandIndex((i) => Math.max(i - 1, 0)); return }
                    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); selectCommand(filteredCommands[activeCommandIndex]); return }
                    if (e.key === 'Escape') { e.preventDefault(); setInput(''); return }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
                }}
                placeholder="Direct command to Caye…"
                disabled={sending}
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
                  flexShrink: 0, width: 32, height: 32, borderRadius: '50%', border: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: sending || !input.trim() ? 'default' : 'pointer',
                  background: sending || !input.trim() ? 'rgba(255,255,255,0.08)' : '#4EBECE',
                  transition: 'background 0.15s ease',
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                  stroke={!input.trim() ? 'rgba(245,245,244,0.35)' : '#0a0a0b'}
                  strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
