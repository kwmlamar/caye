'use client'

import { useState, useEffect, useRef } from 'react'
import CayeMark from '@/components/ui/CayeMark'
import ChannelIcon from '@/components/ui/ChannelIcon'
import type { CayeMessage, CayeBullet, ChannelType } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

function toUiChannel(ch: string): ChannelType {
  if (ch === 'whatsapp') return 'wa'
  if (ch === 'instagram') return 'ig'
  if (ch === 'messenger') return 'fb'
  return 'em'
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000)
  if (diffDays === 0) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function CayePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspaceId } = useWorkspace()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<CayeMessage[]>([])
  const [history, setHistory] = useState<{ from: 'user' | 'caye'; text: string }[]>([])
  const [typing, setTyping] = useState(false)
  const [loading, setLoading] = useState(false)
  const initialized = useRef(false)

  useEffect(() => {
    if (!open || initialized.current) return
    initialized.current = true

    async function loadHeld() {
      setLoading(true)
      try {
        const client = getSupabase()

        const { data: accounts } = await client
          .from('connected_accounts')
          .select('id')
          .eq('user_id', workspaceId)
          .eq('is_active', true)

        const accountIds = (accounts || []).map((a: { id: string }) => a.id)

        if (accountIds.length === 0) {
          setMessages([{ from: 'caye', text: "You're all caught up — nothing needs your attention right now." }])
          return
        }

        const { data: held } = await client
          .from('unified_conversations')
          .select('customer_name, channel_type, human_agent_reason, last_message_preview, last_message_at')
          .in('connected_account_id', accountIds)
          .eq('human_agent_enabled', true)
          .eq('is_archived', false)
          .order('human_agent_marked_at', { ascending: false })
          .limit(10)

        if (!held || held.length === 0) {
          setMessages([{ from: 'caye', text: "You're all caught up — nothing needs your attention right now." }])
          return
        }

        const bullets: CayeBullet[] = held.map((c: {
          customer_name: string | null
          channel_type: string
          human_agent_reason: string | null
          last_message_preview: string | null
          last_message_at: string | null
        }) => ({
          ch: toUiChannel(c.channel_type),
          who: c.customer_name || 'Unknown',
          reason: c.human_agent_reason || c.last_message_preview || '',
          time: formatTime(c.last_message_at),
        }))

        const count = bullets.length
        setMessages([{
          from: 'caye',
          text: `${count} thing${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} your touch right now:`,
          bullets,
          footer: 'Everything else is replied or auto-confirmed. Want me to draft answers for any of these?',
        }])
      } catch (err) {
        console.error('[CayePanel] loadHeld error:', err)
        setMessages([{ from: 'caye', text: "Couldn't load your queue. Try refreshing." }])
      } finally {
        setLoading(false)
      }
    }

    loadHeld()
  }, [open, workspaceId])

  const onSend = async () => {
    const text = input.trim()
    if (!text || typing) return
    setInput('')
    setMessages((m) => [...m, { from: 'user', text }])
    setTyping(true)

    try {
      const { data: { session } } = await getSupabase().auth.getSession()
      const token = session?.access_token || ''

      const res = await fetch('/api/caye/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text, workspaceId, history }),
      })

      const data = await res.json()
      const reply: string = data.reply || "Couldn't reach server. Try again."
      const cayeMsg: CayeMessage = {
        from: 'caye',
        text: reply,
        configUpdated: data.configUpdated,
        fieldChanged: data.fieldChanged,
      }
      setMessages((m) => [...m, cayeMsg])
      setHistory((h) => [...h, { from: 'user', text }, { from: 'caye', text: reply }])
    } catch {
      setMessages((m) => [...m, { from: 'caye', text: "Couldn't reach server. Try again." }])
    } finally {
      setTyping(false)
    }
  }

  return (
    <aside className={'caye-panel' + (open ? ' open' : '')}>
      <header className="cp-head">
        <div className="cp-title">
          <CayeMark size={28} />
          <div>
            <div className="cp-name">Caye</div>
            <div className="cp-status">
              <span className="cp-pulse"></span> Listening
            </div>
          </div>
        </div>
        <button className="cp-close" onClick={onClose}>×</button>
      </header>

<div className="cp-body">
        {loading && (
          <div className="cp-msg caye">
            <CayeMark size={20} />
            <div className="cp-msg-body">
              <div className="cp-msg-bubble" style={{ opacity: 0.6 }}>…</div>
            </div>
          </div>
        )}
        {!loading && messages.map((m, i) => (
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
              {m.configUpdated && (
                <div style={{ fontSize: 11, color: 'var(--tc-ink-mute)', marginTop: 4 }}>
                  settings updated · {m.fieldChanged}
                </div>
              )}
            </div>
          </div>
        ))}
        {typing && (
          <div className="cp-msg caye">
            <CayeMark size={20} />
            <div className="cp-msg-body">
              <div className="cp-msg-bubble" style={{ opacity: 0.6 }}>…</div>
            </div>
          </div>
        )}
      </div>

      <footer className="cp-foot">
        <div className="cp-input">
          <CayeMark size={16} />
          <input
            placeholder="Ask Caye anything…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSend() }}
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
