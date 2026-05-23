'use client'

import { useState, useRef, useEffect } from 'react'
import CayeMark from '@/components/ui/CayeMark'
import { getSupabase } from '@/lib/supabase'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface Props {
  onClose: () => void
  onBookingChanged: () => void
}

export default function AskCayePanel({ onClose, onBookingChanged }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        'Hi — ask me to book someone, check the schedule, or cancel a booking. ' +
        'e.g. "book Jane Doe for 4 tomorrow at 2pm" or "what\'s on Friday?"',
    },
  ])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  async function send() {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setError(null)
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setSending(true)

    try {
      const supabase = getSupabase()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')

      const res = await fetch('/api/calendar/ask-caye', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        // Skip the seed assistant greeting when sending to the API
        body: JSON.stringify({ messages: next.slice(1) }),
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error || `Request failed (${res.status})`)
      }

      const data = (await res.json()) as {
        reply: string
        booking_id?: string
        cancelled_booking_id?: string
      }

      setMessages([...next, { role: 'assistant', content: data.reply || '(no reply)' }])

      if (data.booking_id || data.cancelled_booking_id) {
        onBookingChanged()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setSending(false)
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <aside className="ask-caye-panel">
      <header className="ask-caye-head">
        <div className="ask-caye-title">
          <CayeMark size={16} />
          <span>Ask Caye</span>
        </div>
        <button className="ico-btn" onClick={onClose} aria-label="Close Ask Caye">×</button>
      </header>

      <div className="ask-caye-body" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`ask-caye-msg ${m.role}`}>
            {m.role === 'assistant' && (
              <div className="ask-caye-msg-avatar"><CayeMark size={12} /></div>
            )}
            <div className="ask-caye-msg-bubble">{m.content}</div>
          </div>
        ))}
        {sending && (
          <div className="ask-caye-msg assistant">
            <div className="ask-caye-msg-avatar"><CayeMark size={12} /></div>
            <div className="ask-caye-msg-bubble typing">…</div>
          </div>
        )}
      </div>

      {error && <div className="ask-caye-error">{error}</div>}

      <footer className="ask-caye-foot">
        <textarea
          className="s-textarea ask-caye-input"
          rows={2}
          placeholder="Ask Caye anything about your calendar…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={sending}
        />
        <button
          className="btn-primary sm"
          onClick={send}
          disabled={sending || !input.trim()}
        >
          Send
        </button>
      </footer>
    </aside>
  )
}
