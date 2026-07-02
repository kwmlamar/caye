'use client'

import { useState, useEffect } from 'react'
import { getSession } from '@/lib/supabase'
import { formatDistanceToNow } from '@/lib/utils'
import type { ConversationSummary } from '@/lib/useCommandOverview'

interface ThreadMessage {
  id: string
  sender_type: string
  content: string
  sent_at: string
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

interface Props {
  workspaceId: string
  conversations: ConversationSummary[]
}

export default function CommandConversations({ workspaceId, conversations }: Props) {
  const [tab, setTab] = useState<'all' | 'review'>('all')
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(conversations[0]?.id ?? null)
  const [thread, setThread] = useState<{ customer_name: string | null; messages: ThreadMessage[] } | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)

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

  return (
    <div style={{ height: '100%', display: 'flex', color: '#f5f5f4' }}>
      {/* ── List column ── */}
      <div style={{ width: '46%', borderRight: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 16px 10px' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {(['all', 'review'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: 999,
                  fontSize: 11, fontWeight: 600,
                  background: tab === t ? '#f5f5f4' : 'rgba(255,255,255,0.06)',
                  color: tab === t ? '#0a0a0b' : 'rgba(245,245,244,0.55)',
                }}
              >
                {t === 'all' ? 'All chats' : `Review (${reviewCount})`}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name…"
            style={{
              width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#f5f5f4', outline: 'none',
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
          {list.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'rgba(245,245,244,0.35)', padding: '8px 10px' }}>No conversations.</div>
          ) : (
            list.map((c) => {
              const label = CHANNEL_LABEL[c.channel_type] ?? c.channel_type
              const color = CHANNEL_COLOR[c.channel_type] ?? 'rgba(245,245,244,0.5)'
              return (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                    background: activeId === c.id ? 'rgba(255,255,255,0.06)' : 'transparent',
                    borderRadius: 10, padding: '10px 10px', marginBottom: 2,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.customer_name || 'Unknown'}
                    </span>
                    <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 600, color, background: `${color}1a`, border: `1px solid ${color}4d`, borderRadius: 999, padding: '1px 6px', flexShrink: 0 }}>
                      {label}
                    </span>
                  </div>
                  <p style={{ fontSize: 11.5, color: 'rgba(245,245,244,0.4)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.last_message_preview}
                  </p>
                  {c.human_agent_enabled && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#ff8a6b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {c.human_agent_reason || 'Needs review'}
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* ── Thread detail ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, overflowY: 'auto' }}>
        {!activeSummary ? (
          <div style={{ fontSize: 13, color: 'rgba(245,245,244,0.35)' }}>Select a conversation.</div>
        ) : (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{activeSummary.customer_name || 'Unknown'}</div>
            <div style={{ fontSize: 11, color: 'rgba(245,245,244,0.35)', marginBottom: 14 }}>
              Channel: {CHANNEL_LABEL[activeSummary.channel_type] ?? activeSummary.channel_type}
            </div>
            {threadLoading ? (
              <div style={{ fontSize: 12.5, color: 'rgba(245,245,244,0.4)' }}>Loading…</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {(thread?.messages ?? []).map((m) => (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: m.sender_type === 'business' ? 'flex-end' : 'flex-start',
                      maxWidth: '80%',
                      background: m.sender_type === 'business' ? 'rgba(125,201,203,0.12)' : 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 12,
                      padding: '8px 12px',
                    }}
                  >
                    <p style={{ fontSize: 13, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>{m.content}</p>
                    <span style={{ fontSize: 10, color: 'rgba(245,245,244,0.35)' }}>{formatDistanceToNow(m.sent_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
