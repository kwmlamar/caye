'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import CayeMark from '@/components/ui/CayeMark'
import ChannelIcon from '@/components/ui/ChannelIcon'
import type { CayeMessage, CayeBullet, ChannelType } from '@/lib/types'
import { useWorkspace } from '@/lib/workspace-context'
import { getSupabase } from '@/lib/supabase'

const MIN_WIDTH = 300
const MAX_WIDTH = 620
const DEFAULT_WIDTH = 340

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
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH)
  const initialized = useRef(false)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(DEFAULT_WIDTH)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartWidth.current = panelWidth
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const delta = dragStartX.current - ev.clientX
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartWidth.current + delta))
      setPanelWidth(next)
    }
    const onUp = () => {
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [panelWidth])

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
        configUpdates: Array.isArray(data.configUpdates) ? data.configUpdates : undefined,
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
    <aside className={'caye-panel' + (open ? ' open' : '')} style={{ width: panelWidth }}>
      <div className="cp-resize-handle" onMouseDown={onDragStart} title="Drag to resize" />
      <header className="cp-head">
        <div className="cp-head-bg" />
        <div className="cp-title">
          <div className="cp-mark-wrap">
            <CayeMark size={28} />
          </div>
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
              <div className="cp-msg-bubble cp-thinking">
                <span className="cp-dot" />
                <span className="cp-dot" />
                <span className="cp-dot" />
              </div>
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
              {m.configUpdates && m.configUpdates.length > 0 && (
                <div className="cp-config-updates">
                  {m.configUpdates.map((u, k) => (
                    <span key={k} className="cp-config-chip">
                      <span className="cp-config-check">✓</span>
                      {u.summary}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {typing && (
          <div className="cp-msg caye">
            <CayeMark size={20} />
            <div className="cp-msg-body">
              <div className="cp-msg-bubble cp-thinking">
                <span className="cp-dot" />
                <span className="cp-dot" />
                <span className="cp-dot" />
              </div>
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
          <button className="cp-attach-btn" title="Attach file" type="button" style={{ opacity: 0.5, marginRight: 4, transition: 'opacity 0.2s', cursor: 'pointer', display: 'flex', alignItems: 'center' }} onMouseEnter={(e) => e.currentTarget.style.opacity = '1'} onMouseLeave={(e) => e.currentTarget.style.opacity = '0.5'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button onClick={onSend} className="cp-send" aria-label="Send message">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          </button>
        </div>
        <div className="cp-foot-meta">
          <span>just tell me to change anything</span>
        </div>
      </footer>
    </aside>
  )
}
