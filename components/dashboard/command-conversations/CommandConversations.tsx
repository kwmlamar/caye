'use client'

import { useState, useEffect, useRef } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import { CayeMark } from '@/components/brand/CayeMark'
import { FormattedReplyText } from '@/components/ui/FormattedReplyText'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import type { ConversationSummary } from '@/lib/useCommandOverview'

const GLASS = { backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)' } as const

interface ThreadMessage {
  id: string
  sender_type: string
  content: string
  sent_at: string
  metadata?: { generated_by?: string } | null
  is_internal?: boolean
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WA',
  email: 'Mail',
  instagram: 'IG',
  messenger: 'FB',
  sms: 'SMS',
}
const CHANNEL_COLOR: Record<string, string> = {
  whatsapp: '#22c55e',
  email: '#7DC9CB',
  instagram: '#FFD68F',
  messenger: '#7DC9CB',
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
        background: active ? 'rgba(125,201,203,0.09)' : hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        borderRadius: 10, padding: '10px 10px 10px 14px', marginBottom: 2,
        transition: 'background 0.12s ease',
      }}
    >
      {active && (
        <span aria-hidden style={{ position: 'absolute', left: 3, top: 8, bottom: 8, width: 2.5, borderRadius: 3, background: '#7DC9CB' }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.customer_name || 'Unknown'}
        </span>
        <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 600, color, background: `${color}1a`, border: `1px solid ${color}4d`, borderRadius: 999, padding: '1px 6px', flexShrink: 0 }}>
          {label}
        </span>
      </div>
      <p style={{
        fontSize: 11.5, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        color: c.human_agent_enabled ? 'rgba(251,113,133,0.85)' : 'rgba(245,245,244,0.4)',
      }}>
        {c.human_agent_enabled ? (c.human_agent_reason || 'Needs review') : c.last_message_preview}
      </p>
      {c.human_agent_enabled && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4,
          fontSize: 9, fontWeight: 600, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase',
          color: '#fb7185', background: 'rgba(251,113,133,0.1)', border: '1px solid rgba(251,113,133,0.3)',
          borderRadius: 999, padding: '2px 8px',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#fb7185', flexShrink: 0 }} />
          Needs review
        </span>
      )}
    </button>
  )
}

interface Props {
  workspaceId: string
  conversations: ConversationSummary[]
  /** Set by a sibling panel (CommandCalendar's booking click-through) to
   *  jump this panel to a specific conversation without owning its
   *  internal selection/search/tab state. */
  selectedConversationId?: string | null
}

export default function CommandConversations({ workspaceId, conversations, selectedConversationId }: Props) {
  const [tab, setTab] = useState<'all' | 'review'>('all')
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(conversations[0]?.id ?? null)
  const [thread, setThread] = useState<{ customer_name: string | null; messages: ThreadMessage[] } | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const threadContainerRef = useRef<HTMLDivElement | null>(null)

  // A booking click in CommandCalendar routes here — jump straight to that
  // customer's thread, clearing any tab/search filter that would hide it.
  useEffect(() => {
    if (!selectedConversationId) return
    setActiveId(selectedConversationId)
    setTab('all')
    setQuery('')
  }, [selectedConversationId])

  const reviewCount = conversations.filter((c) => c.human_agent_enabled).length
  const list = conversations
    .filter((c) => (tab === 'review' ? c.human_agent_enabled : true))
    .filter((c) => (c.customer_name ?? '').toLowerCase().includes(query.toLowerCase()))

  useEffect(() => {
    if (!activeId) { setThread(null); return }
    let cancelled = false

    async function loadThread() {
      setThreadLoading(true)
      const { session } = await getSession()
      if (!session) { setThreadLoading(false); return }
      try {
        const res = await fetch(`/api/founder/conversation-messages?workspaceId=${workspaceId}&conversationId=${activeId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (!cancelled && res.ok) setThread(json)
      } finally {
        if (!cancelled) setThreadLoading(false)
      }
    }

    loadThread()
    return () => { cancelled = true }
  }, [activeId, workspaceId])

  const activeSummary = conversations.find((c) => c.id === activeId)

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
      <div style={{ width: '46%', borderRight: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
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
              border: `1px solid ${searchFocused ? 'rgba(125,201,203,0.5)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#f5f5f4', outline: 'none',
              boxShadow: searchFocused ? '0 0 0 3px rgba(125,201,203,0.1)' : 'none',
              transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
          {list.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'rgba(245,245,244,0.35)', padding: '8px 10px' }}>No conversations.</div>
          ) : (
            list.map((c) => (
              <ConversationRow key={c.id} c={c} active={activeId === c.id} onClick={() => setActiveId(c.id)} />
            ))
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
            <div style={{ padding: '14px 16px', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)', ...GLASS }}>
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
                    const noteBody = m.content.replace(/^\[[^\]]*\]\s*/, '')
                    return (
                      <div key={m.id} style={{
                        alignSelf: 'stretch', display: 'flex', gap: 8, alignItems: 'flex-start',
                        background: 'rgba(255,214,143,0.06)', border: '1px solid rgba(255,214,143,0.25)',
                        borderRadius: 10, padding: '8px 12px',
                      }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFD68F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 3, flexShrink: 0 }}>
                          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
                        </svg>
                        <div>
                          <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700, letterSpacing: '0.08em', color: '#FFD68F', textTransform: 'uppercase', marginBottom: 2 }}>
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
                        <div style={{ borderRight: '2px solid #7DC9CB', padding: '1px 12px 1px 0', textAlign: 'left' }}>
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
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.08)',
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
          </>
        )}
      </div>
    </div>
  )
}
