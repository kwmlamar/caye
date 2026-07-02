'use client'

import { useState, useEffect, useRef } from 'react'
import { getSession } from '@/lib/supabase'

const CARD_BG = '#121214'
const CARD_BORDER = '#1f1f23'

interface OperatorMessage {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  created_at: string
}

const QUICK_COMMANDS = ['pause yuhself', 'status briefing', 'vibe check', 'cancellation override']

// Web front end for the same back-office agent the founder already
// texts over WhatsApp (lib/caye-agent, mode: 'back-office') — same
// history (caye_operator_messages), same tools, same trust level.
// Not a read-only log: sending a message here really calls the agent.
export default function CayeDirect({ workspaceId }: { workspaceId: string }) {
  const [messages, setMessages] = useState<OperatorMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const { session } = await getSession()
      if (!session) { setLoading(false); return }
      const res = await fetch(`/api/founder/caye-direct?workspaceId=${workspaceId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (!cancelled && res.ok) setMessages(json.messages)
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    setInput('')

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', color: '#f4f4f5' }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${CARD_BORDER}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.05em' }}>CAYE DIRECT</span>
        <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: '#7DC9CB', background: 'rgba(125,201,203,0.1)', border: '1px solid rgba(125,201,203,0.3)', borderRadius: 999, padding: '2px 8px' }}>
          BACK-OFFICE SHELL
        </span>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {loading ? (
          <div style={{ fontSize: 12.5, color: '#71717a' }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ fontSize: 12.5, color: '#71717a' }}>No history yet — say hello.</div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.direction === 'outbound' ? 'flex-start' : 'flex-end',
                maxWidth: '82%',
                background: m.direction === 'outbound' ? 'rgba(125,201,203,0.1)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${CARD_BORDER}`,
                borderRadius: 12,
                padding: '8px 12px',
              }}
            >
              <p style={{ fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{m.body}</p>
            </div>
          ))
        )}
        {sending && <div style={{ fontSize: 11.5, color: '#71717a', alignSelf: 'flex-start' }}>Caye is thinking…</div>}
      </div>

      <div style={{ padding: 14, borderTop: `1px solid ${CARD_BORDER}` }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {QUICK_COMMANDS.map((cmd) => (
            <button
              key={cmd}
              onClick={() => send(cmd)}
              disabled={sending}
              style={{
                fontSize: 11, fontFamily: 'var(--font-mono)', color: '#a1a1aa',
                background: CARD_BG, border: `1px solid ${CARD_BORDER}`, borderRadius: 999,
                padding: '5px 10px', cursor: sending ? 'default' : 'pointer',
              }}
            >
              {cmd}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); send(input) }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Direct command to Caye (e.g. 'pause yuhself')…"
            disabled={sending}
            style={{
              flex: 1, background: 'rgba(255,255,255,0.05)', border: `1px solid ${CARD_BORDER}`,
              borderRadius: 10, padding: '9px 12px', fontSize: 13, color: '#f4f4f5', outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            style={{
              width: 38, height: 38, borderRadius: 10, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#7DC9CB', border: 'none', color: '#0a0a0b', cursor: sending ? 'default' : 'pointer',
              opacity: !input.trim() || sending ? 0.5 : 1,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  )
}
