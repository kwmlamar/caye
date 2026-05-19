'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Avatar from '@/components/ui/Avatar'
import ChannelIcon from '@/components/ui/ChannelIcon'
import CayeMark from '@/components/ui/CayeMark'
import {
  getConnectedAccounts,
  getUnifiedConversations,
  getUnifiedMessages,
  sendUnifiedMessage,
  updateUnifiedConversation,
  subscribeToUnifiedMessages,
  subscribeToUnifiedConversations,
} from '@/lib/unified-inbox'
import { generateId } from '@/lib/utils'
import { useDashboard } from '@/lib/dashboard-context'
import type {
  ConversationWithAccount,
  UnifiedMessage,
  UnifiedConversation,
} from '@/types/unified-inbox'
import type { ChannelType } from '@/lib/types'

// DB channel_type → UI ChannelType
function toUiChannel(ch: string): ChannelType {
  if (ch === 'whatsapp') return 'wa'
  if (ch === 'instagram') return 'ig'
  if (ch === 'messenger') return 'fb'
  if (ch === 'email') return 'em'
  return 'wa'
}

function channelLabel(ch: ChannelType): string {
  if (ch === 'wa') return 'WhatsApp'
  if (ch === 'ig') return 'Instagram'
  if (ch === 'fb') return 'Messenger'
  return 'Email'
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

type Filter = 'all' | 'unread' | 'caye-held'

function ConversationRow({
  conv,
  active,
  onClick,
}: {
  conv: ConversationWithAccount
  active: boolean
  onClick: () => void
}) {
  const name = conv.customer_name || 'Unknown'
  const ch = toUiChannel(conv.channel_type)

  return (
    <button
      className={'conv-row' + (active ? ' active' : '')}
      onClick={onClick}
    >
      <div className="conv-av-wrap">
        <Avatar name={name} size={40} />
        <span className="conv-channel">
          <ChannelIcon ch={ch} size={16} />
        </span>
      </div>
      <div className="conv-body">
        <div className="conv-line1">
          <span className="conv-name">{name}</span>
          <span className="conv-time">{formatTime(conv.last_message_at)}</span>
        </div>
        <div className="conv-line2">
          <span className="conv-preview">{conv.last_message_preview || ''}</span>
          {conv.unread_count > 0 && (
            <span className="conv-unread">{conv.unread_count}</span>
          )}
        </div>
        {conv.human_agent_enabled && (
          <div className="conv-caye held">
            <span className="caye-pip" />
            <span>Caye held</span>
          </div>
        )}
      </div>
    </button>
  )
}

export default function ChatsScreen({ openCaye }: { openCaye: () => void }) {
  const { pendingContactChannelId, setPendingContactChannelId } = useDashboard()
  const [conversations, setConversations] = useState<ConversationWithAccount[]>([])
  const [selectedConv, setSelectedConv] = useState<ConversationWithAccount | null>(null)
  const [messages, setMessages] = useState<UnifiedMessage[]>([])
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [accountIds, setAccountIds] = useState<string[]>([])

  const mountedRef = useRef(true)
  const selectedRef = useRef(selectedConv)
  const fetchConvsRef = useRef<() => void>(() => {})
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    selectedRef.current = selectedConv
  }, [selectedConv])

  // Scroll to bottom when messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Fetch connected account IDs once (needed for realtime subscriptions)
  useEffect(() => {
    let ignore = false
    getConnectedAccounts().then(({ data }) => {
      if (!ignore) setAccountIds(data.map((a) => a.id))
    })
    return () => { ignore = true }
  }, [])

  // Fetch conversations (re-runs when search changes)
  const fetchConversations = useCallback(async () => {
    if (!mountedRef.current) return
    setLoadingConvs(true)
    const { data, error } = await getUnifiedConversations(
      'all',
      searchQuery || undefined,
      50,
      false
    )
    if (!mountedRef.current) return
    if (!error) {
      setConversations(data)
      // Auto-select first if nothing selected
      if (!selectedRef.current && data.length > 0) {
        setSelectedConv(data[0])
      }
    }
    if (mountedRef.current) setLoadingConvs(false)
  }, [searchQuery])

  useEffect(() => {
    fetchConvsRef.current = fetchConversations
  }, [fetchConversations])

  useEffect(() => {
    fetchConversations()
  }, [fetchConversations])

  // Auto-select conversation when navigated from contacts page
  useEffect(() => {
    if (!pendingContactChannelId || conversations.length === 0) return
    const conv = conversations.find(c => c.customer_id === pendingContactChannelId)
    if (conv) {
      setSelectedConv(conv)
      setPendingContactChannelId(null)
    }
  }, [pendingContactChannelId, conversations])

  // Load messages + subscribe when conversation selected
  useEffect(() => {
    if (!selectedConv) {
      setMessages([])
      return
    }

    setMessages([])
    let active = true
    const convId = selectedConv.id
    const initialUnreadCount = selectedConv.unread_count

    // 1. Subscribe first so we catch messages that arrive while fetching
    const unsubscribe = subscribeToUnifiedMessages(convId, (msg, eventType) => {
      if (!active) return
      setMessages((prev) => {
        if (eventType === 'INSERT' || eventType === 'UPDATE') {
          const existingIdx = prev.findIndex((m) => m.id === msg.id)
          if (existingIdx >= 0) {
            return prev.map((m, i) => (i === existingIdx ? msg : m))
          }
          // Replace matching optimistic message
          const optimisticIdx = prev.findIndex(
            (m) =>
              m.sender_type === 'business' &&
              m.status === 'sending' &&
              m.content === msg.content &&
              Math.abs(new Date(m.sent_at).getTime() - new Date(msg.sent_at).getTime()) < 30000
          )
          if (optimisticIdx >= 0) {
            return prev.map((m, i) => (i === optimisticIdx ? msg : m))
          }
          const merged = [...prev, msg]
          const byId = new Map(merged.map((m) => [m.id, m]))
          return Array.from(byId.values()).sort(
            (a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()
          )
        }
        return prev
      })
    })

    // 2. Fetch existing messages
    async function loadMessages() {
      setLoadingMsgs(true)
      const { data, error } = await getUnifiedMessages(convId)
      if (!active) return

      if (!error) {
        setMessages((prev) => {
          const validPrev = prev.filter((m) => m.conversation_id === convId)
          const merged = [...data, ...validPrev]
          const byId = new Map(merged.map((m) => [m.id, m]))
          return Array.from(byId.values()).sort(
            (a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()
          )
        })
      }

      if (active) setLoadingMsgs(false)

      // Mark as read
      if (active && initialUnreadCount > 0) {
        updateUnifiedConversation(convId, { unread_count: 0 })
        setConversations((prev) =>
          prev.map((c) => (c.id === convId ? { ...c, unread_count: 0 } : c))
        )
      }
    }

    loadMessages()

    return () => {
      active = false
      unsubscribe()
    }
  }, [selectedConv?.id])

  // Real-time conversation list updates
  useEffect(() => {
    if (accountIds.length === 0) return

    const unsubscribe = subscribeToUnifiedConversations(
      accountIds,
      (updatedConv: UnifiedConversation) => {
        const isViewing = selectedRef.current?.id === updatedConv.id

        if (isViewing && updatedConv.unread_count > 0) {
          updatedConv = { ...updatedConv, unread_count: 0 }
          updateUnifiedConversation(updatedConv.id, { unread_count: 0 })
        }

        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === updatedConv.id)
          if (idx === -1) {
            fetchConvsRef.current()
            return prev
          }
          return prev
            .map((c) => (c.id === updatedConv.id ? { ...c, ...updatedConv } : c))
            .sort(
              (a, b) =>
                new Date(b.last_message_at || b.created_at).getTime() -
                new Date(a.last_message_at || a.created_at).getTime()
            )
        })

        setSelectedConv((prev) =>
          !prev || prev.id !== updatedConv.id ? prev : { ...prev, ...updatedConv }
        )
      }
    )

    return unsubscribe
  }, [accountIds])

  // Send message handler
  async function handleSend() {
    if (!selectedConv || !replyText.trim() || sending) return
    const text = replyText.trim()
    setReplyText('')
    setSending(true)

    const tempMsg: UnifiedMessage = {
      id: generateId(),
      conversation_id: selectedConv.id,
      channel_message_id: null,
      sender_type: 'business',
      content: text,
      message_type: 'text',
      sent_at: new Date().toISOString(),
      delivered_at: null,
      read_at: null,
      failed_at: null,
      status: 'sending',
      error_message: null,
      metadata: {},
      created_at: new Date().toISOString(),
    }

    setMessages((prev) => [...prev, tempMsg])
    setConversations((prev) =>
      prev.map((c) =>
        c.id === selectedConv.id
          ? { ...c, last_message_at: tempMsg.sent_at, last_message_preview: text.slice(0, 100) }
          : c
      )
    )

    const { data, error } = await sendUnifiedMessage(selectedConv.id, text)
    setSending(false)

    if (error) {
      setMessages((prev) =>
        prev.map((m) => (m.id === tempMsg.id ? { ...m, status: 'failed' as const } : m))
      )
    } else if (data) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === data.id)) return prev
        return prev.map((m) => (m.id === tempMsg.id ? data : m))
      })
    }
  }

  // Filtered conversation list
  const filtered = conversations.filter((c) => {
    if (filter === 'unread') return c.unread_count > 0
    if (filter === 'caye-held') return c.human_agent_enabled
    return true
  })

  const unreadCount = conversations.filter((c) => c.unread_count > 0).length
  const heldCount = conversations.filter((c) => c.human_agent_enabled).length

  const selName = selectedConv?.customer_name || 'Unknown'
  const selCh = selectedConv ? toUiChannel(selectedConv.channel_type) : 'wa'

  return (
    <div className="chats-screen">

      {/* INBOX LIST */}
      <aside className="inbox-col">
        <div className="inbox-head">
          <div className="inbox-title">
            <h2>Chats</h2>
            <span className="count-pill">{conversations.length}</span>
          </div>
          <div className="search">
            <span className="ico">⌕</span>
            <input
              placeholder="Search messages, names…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="seg">
            <button
              className={filter === 'all' ? 'on' : ''}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            <button
              className={filter === 'unread' ? 'on' : ''}
              onClick={() => setFilter('unread')}
            >
              Unread
              {unreadCount > 0 && <span className="seg-count">{unreadCount}</span>}
            </button>
            <button
              className={filter === 'caye-held' ? 'on' : ''}
              onClick={() => setFilter('caye-held')}
            >
              <span className="caye-dot" /> Caye held
              {heldCount > 0 && <span className="seg-count">{heldCount}</span>}
            </button>
          </div>
        </div>

        <div className="inbox-list">
          {loadingConvs ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
              {searchQuery ? 'No results' : 'No conversations yet'}
            </div>
          ) : (
            filtered.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                active={c.id === selectedConv?.id}
                onClick={() => setSelectedConv(c)}
              />
            ))
          )}
        </div>
      </aside>

      {/* THREAD PANE */}
      <section className="thread-col">
        {!selectedConv ? (
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            color: 'var(--tc-ink-faint)',
            fontSize: 13,
          }}>
            <CayeMark size={28} />
            <span>Select a conversation</span>
          </div>
        ) : (
          <>
            <header className="thread-head">
              <div className="thread-who">
                <Avatar name={selName} size={42} />
                <div>
                  <div className="thread-name">{selName}</div>
                  <div className="thread-role">
                    <ChannelIcon ch={selCh} size={14} /> {channelLabel(selCh)}
                  </div>
                </div>
              </div>
              <div className="thread-actions">
                <span className="ai-toggle header">
                  <span className="ai-toggle-track on">
                    <span className="ai-toggle-thumb" />
                  </span>
                  Caye auto-reply
                </span>
                <button className="ghost-btn" title="Open contact">View contact</button>
                <button className="ghost-btn" title="Book this guest">+ Booking</button>
                <button className="ghost-btn icon-only" title="More">⋯</button>
              </div>
            </header>

            {selectedConv.human_agent_enabled && (
              <div className="caye-strip held">
                <CayeMark size={14} />
                <span className="caye-strip-text">
                  {selectedConv.human_agent_reason || 'Caye held — needs your attention'}
                </span>
              </div>
            )}

            <div className="thread-body">
              {loadingMsgs ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  Loading messages…
                </div>
              ) : messages.length === 0 ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--tc-ink-faint)', fontSize: 13 }}>
                  No messages yet
                </div>
              ) : (
                messages.map((msg) => {
                  const side = msg.sender_type === 'customer' ? 'in' : 'out'
                  return (
                    <div key={msg.id} className={'msg-row ' + side}>
                      {side === 'in' && <Avatar name={selName} size={28} />}
                      <div className="msg-stack">
                        <div className={'bubble ' + side}>{msg.content || ''}</div>
                        <div className="msg-time">
                          {formatTime(msg.sent_at)}
                          {msg.status === 'sending' && ' · sending…'}
                          {msg.status === 'failed' && (
                            <span style={{ color: 'var(--tc-coral)' }}> · failed to send</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <footer className="reply-box">
              <div className="reply-tabs">
                <button className="rt on">Reply</button>
                <button className="rt">Internal note</button>
              </div>
              <textarea
                placeholder={`Write back to ${selName.split(' ')[0]}…`}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend()
                }}
              />
              <div className="reply-footer">
                <div className="reply-tools">
                  <button title="Attach" aria-label="Attach">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.5 4 5.8 8.7a2.4 2.4 0 1 0 3.4 3.4l5-5a4 4 0 1 0-5.7-5.6L3.4 6.6" />
                    </svg>
                  </button>
                  <button title="Template" aria-label="Template">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2.5" y="3" width="11" height="10" rx="1.6" />
                      <path d="M2.5 6.5h11M5.5 9.5h5M5.5 11h3" />
                    </svg>
                  </button>
                  <button
                    className="caye-btn icon-only"
                    title="Ask Caye"
                    aria-label="Ask Caye"
                    onClick={openCaye}
                  >
                    <CayeMark size={14} />
                  </button>
                </div>
                <button
                  className="btn-send"
                  onClick={handleSend}
                  disabled={!replyText.trim() || sending}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}
