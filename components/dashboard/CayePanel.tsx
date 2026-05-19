'use client'

import { useState } from 'react'
import CayeMark from '@/components/ui/CayeMark'
import ChannelIcon from '@/components/ui/ChannelIcon'
import { CAYE_PANEL_HELD } from '@/lib/data/conversations'
import type { CayeMessage } from '@/lib/types'

const INITIAL_MESSAGES: CayeMessage[] = [
  {
    from: 'user',
    text: "what's still waiting on me?",
  },
  {
    from: 'caye',
    text: '3 things need your touch right now:',
    bullets: CAYE_PANEL_HELD.map((h) => ({
      ch: h.channel,
      who: h.who,
      reason: h.reason,
      time: h.time,
    })),
    footer: 'Everything else is replied or auto-confirmed. Want me to draft answers for any of these?',
  },
]

export default function CayePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<CayeMessage[]>(INITIAL_MESSAGES)

  const onSend = () => {
    if (!input.trim()) return
    setMessages((m) => [...m, { from: 'user', text: input }])
    setInput('')
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          from: 'caye',
          text: "On it. I'll draft replies in the same tone you used with Sandra Sweeting last week and queue them for your review.",
        },
      ])
    }, 700)
  }

  return (
    <aside className={'caye-panel' + (open ? ' open' : '')}>
      <header className="cp-head">
        <div className="cp-title">
          <CayeMark size={28} />
          <div>
            <div className="cp-name">Caye</div>
            <div className="cp-status">
              <span className="cp-pulse"></span> Listening · Karenda&apos;s voice
            </div>
          </div>
        </div>
        <button className="cp-close" onClick={onClose}>×</button>
      </header>

      <div className="cp-context">
        <span className="cp-context-label">CONTEXT</span>
        <span className="cp-context-chip">📅 Today&apos;s calendar</span>
        <span className="cp-context-chip">💬 126 chats</span>
        <span className="cp-context-chip">+ Add</span>
      </div>

      <div className="cp-body">
        {messages.map((m, i) => (
          <div key={i} className={'cp-msg ' + m.from}>
            {m.from === 'caye' && <CayeMark size={20} />}
            <div className="cp-msg-body">
              <div className="cp-msg-bubble">
                <div>{m.text}</div>
                {m.bullets && (
                  <ul className="cp-bullets">
                    {m.bullets.map((b, j) => (
                      <li key={j}>
                        <ChannelIcon ch={b.ch} size={14} />
                        <div>
                          <div className="cp-b-top">
                            <strong>{b.who}</strong>
                            <span className="cp-b-time">{b.time}</span>
                          </div>
                          <div className="cp-b-reason">{b.reason}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {m.footer && <div className="cp-msg-footer">{m.footer}</div>}
              </div>
              {m.from === 'caye' && i === messages.length - 1 && (
                <div className="cp-quick">
                  <button>Draft replies</button>
                  <button>Open Brielle&apos;s thread</button>
                  <button>Set policy: dogs</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <footer className="cp-foot">
        <div className="cp-input">
          <CayeMark size={16} />
          <input
            placeholder="Ask Caye anything…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
          />
          <button onClick={onSend} className="cp-send">↵</button>
        </div>
        <div className="cp-foot-meta">
          <span>configure tone in Settings</span>
        </div>
      </footer>
    </aside>
  )
}
