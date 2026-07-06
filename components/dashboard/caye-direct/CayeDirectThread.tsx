'use client'

import { useState, useEffect, useRef } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { CayeMark } from '@/components/brand/CayeMark'
import { FormattedReplyText } from '@/components/ui/FormattedReplyText'

const CARD_BORDER = '#1f1f23'
const NEAR_BOTTOM_PX = 96
const TEXTAREA_MAX_H = 120
const GLASS = { backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' } as const

interface OperatorMessage {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  created_at: string
}

type GroupPos = 'single' | 'first' | 'middle' | 'last'

const QUICK_COMMANDS = ['pause yuhself', 'status briefing', 'vibe check', 'cancellation override']

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

function QuickCommandChip({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 11, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
        color: hover && !disabled ? '#dff4f4' : '#a1a1aa',
        background: hover && !disabled ? 'rgba(125,201,203,0.1)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${hover && !disabled ? 'rgba(125,201,203,0.45)' : CARD_BORDER}`,
        borderRadius: 999, padding: '5px 10px 5px 8px', cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease',
      }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.7, flexShrink: 0 }}>
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
      {label}
    </button>
  )
}

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, alignSelf: 'flex-start', animation: 'caye-msg-in 0.25s ease-out' }}>
      <CayeMark size={20} />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 3,
        background: 'rgba(0,119,139,0.14)', border: '1px solid rgba(0,119,139,0.35)',
        borderRadius: '16px 16px 16px 4px', padding: '11px 13px',
      }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 5, height: 5, borderRadius: '50%', background: '#7DC9CB',
              animation: 'caye-typing-dot 1.1s ease-in-out infinite',
              animationDelay: `${i * 0.15}s`,
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

function EmptyState({ operatorLabel, readOnly }: { operatorLabel: string; readOnly: boolean }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center', padding: '0 30px' }}>
      <div style={{ position: 'relative' }}>
        <div aria-hidden style={{ position: 'absolute', inset: -10, borderRadius: '50%', background: 'radial-gradient(circle, rgba(125,201,203,0.18), transparent 70%)' }} />
        <CayeMark size={40} />
      </div>
      <div>
        <div style={{ fontSize: 14, fontFamily: 'var(--font-display)', fontWeight: 600, color: '#f4f4f5' }}>
          {readOnly ? `No history with ${operatorLabel} yet` : 'Say hello to Caye'}
        </div>
        <p style={{ fontSize: 12.5, color: '#71717a', lineHeight: 1.55, marginTop: 6, maxWidth: 260 }}>
          {readOnly
            ? `Nothing to show yet — this fills in once ${operatorLabel} texts Caye's back-office number.`
            : "This is the same agent that runs your back office over WhatsApp. Send a command below, or tap a shortcut to get going."}
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
}

// Web front end for the same back-office agent operators already text
// over WhatsApp (lib/caye-agent, mode: 'back-office') — same
// history (caye_operator_messages), same tools, same trust level.
// Scoped to one operator's conversation at a time (see CayeDirect.tsx for
// the operator switcher) so multiple people sharing a workspace's
// back-office channel don't get merged into one confusing stream.
export default function CayeDirectThread({ workspaceId, operatorId, operatorLabel, readOnly }: Props) {
  const [messages, setMessages] = useState<OperatorMessage[]>([])
  const [input, setInput] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [showJump, setShowJump] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const atBottomRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const { session } = await getSession()
      if (!session) { setLoading(false); return }
      const res = await fetch(`/api/founder/caye-direct?workspaceId=${workspaceId}&operatorId=${operatorId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!cancelled && res.ok) setMessages(json.messages)
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId, operatorId])

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

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending || readOnly) return
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

    const { session } = await getSession()
    if (!session) { setSending(false); return }

    try {
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
    } finally {
      setSending(false)
    }
  }

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
          0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-2px); }
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
        .caye-direct-textarea::placeholder { color: rgba(244,244,245,0.32); }
      `}</style>

      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${CARD_BORDER}`, background: 'rgba(255,255,255,0.02)', ...GLASS }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{operatorLabel}</span>
        <span style={{ fontSize: 11, color: '#52525b' }}>↔ Caye</span>
        {readOnly && (
          <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: '#71717a', background: 'rgba(255,255,255,0.05)', border: `1px solid ${CARD_BORDER}`, borderRadius: 999, padding: '2px 8px', marginLeft: 'auto' }}>
            READ-ONLY · REPLIES VIA WHATSAPP
          </span>
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
                      // No box for Caye — her words sit in the open, set off
                      // by a single accent rule, so long replies stay easy
                      // to read instead of fighting a tinted container.
                      // The operator's own words keep the bubble, so the
                      // two voices still read as visually distinct.
                      <div style={{ borderLeft: '2px solid #7DC9CB', padding: '1px 0 1px 12px' }}>
                        <FormattedReplyText text={m.body} style={{ fontSize: 14, lineHeight: 1.6, color: '#f4f4f5' }} />
                      </div>
                    ) : (
                      <div style={{
                        background: 'rgba(255,255,255,0.06)', border: `1px solid ${CARD_BORDER}`,
                        borderRadius: bubbleRadius(isCaye, pos), padding: '9px 12px',
                      }}>
                        <p style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: '#f4f4f5' }}>{m.body}</p>
                      </div>
                    )}
                    {showMeta && (
                      <div style={{
                        fontSize: 9.5, fontFamily: 'var(--font-mono)', color: '#52525b', marginTop: 4,
                        textAlign: isCaye ? 'left' : 'right', padding: '0 2px',
                      }}>
                        {formatDistanceToNow(m.created_at)}
                      </div>
                    )}
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
              background: '#7DC9CB', border: 'none', borderRadius: 999, padding: '6px 12px 6px 10px',
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
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${CARD_BORDER}`, fontSize: 11.5, color: '#52525b', textAlign: 'center', background: 'rgba(255,255,255,0.02)', ...GLASS }}>
          {operatorLabel} texts Caye directly from their own WhatsApp — you can watch here, not send as them.
        </div>
      ) : (
        <div style={{ padding: 14, borderTop: `1px solid ${CARD_BORDER}`, background: 'rgba(255,255,255,0.02)', ...GLASS }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {QUICK_COMMANDS.map((cmd) => (
              <QuickCommandChip key={cmd} label={cmd} disabled={sending} onClick={() => send(cmd)} />
            ))}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); send(input) }}
            style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
              }}
              placeholder="Direct command to Caye (e.g. 'pause yuhself')…"
              disabled={sending}
              rows={1}
              className="caye-direct-textarea"
              style={{
                flex: 1, resize: 'none', background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${inputFocused ? 'rgba(125,201,203,0.55)' : CARD_BORDER}`,
                borderRadius: 14, padding: '9px 12px', fontSize: 13, lineHeight: 1.4, color: '#f4f4f5', outline: 'none',
                fontFamily: 'var(--font-sans)', maxHeight: TEXTAREA_MAX_H,
                boxShadow: inputFocused ? '0 0 0 3px rgba(125,201,203,0.12)' : 'none',
                transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
              }}
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              style={{
                width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'linear-gradient(135deg, #00778B, #7DC9CB)', border: 'none', color: '#0a0a0b',
                cursor: sending ? 'default' : 'pointer',
                opacity: !input.trim() || sending ? 0.4 : 1,
                transition: 'opacity 0.15s ease, transform 0.1s ease',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
