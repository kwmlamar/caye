'use client'

import { useState } from 'react'

// Mock data shaped like the eventual real query (unified_conversations +
// unified_messages, joined through connected_accounts) so wiring real
// data in later is a data-swap, not a redesign. Frontend-first per
// 2026-07-02 — no Supabase calls in this file yet.
interface MockMessage {
  from: 'customer' | 'caye'
  text: string
  time: string
}
interface MockConversation {
  id: string
  name: string
  channel: 'WA' | 'Mail' | 'IG'
  preview: string
  time: string
  needsReview?: boolean
  messages: MockMessage[]
}

const CHANNEL_COLOR: Record<MockConversation['channel'], string> = {
  WA: '#22c55e',
  Mail: '#7DC9CB',
  IG: '#FFD68F',
}

const MOCK_CONVERSATIONS: MockConversation[] = [
  {
    id: '1', name: 'Marcus Sterling', channel: 'WA', time: '10:14 AM',
    preview: "Excellent, Marcus! That's two spots booked for you guys.",
    messages: [
      { from: 'customer', text: 'Hey! I saw your tour for the SS Sapona snorkelling. Do you guys have availability for tomorrow morning?', time: '10:05 AM' },
      { from: 'caye', text: "Hey Marcus! Caye here with Bimini Island Tours. Yes! We absolutely have space on tomorrow at 9:00 AM from Big Game Club Marina.", time: '10:14 AM' },
    ],
  },
  {
    id: '2', name: 'Clara Oswald', channel: 'Mail', time: '09:42 AM',
    preview: '[Hoping to assist] Hello Clara, I am alerting our dock captain...',
    needsReview: true,
    messages: [
      { from: 'customer', text: 'Hi, does the snorkel trip include equipment for my two kids (ages 8 and 11)?', time: '09:30 AM' },
      { from: 'caye', text: '[Hoping to assist] Hello Clara, I am alerting our dock captain right away to confirm youth-size gear availability.', time: '09:42 AM' },
    ],
  },
  {
    id: '3', name: 'Dave Batista', channel: 'IG', time: '08:15 AM',
    preview: 'Caye flagged: Refund Override / Custom Boat Schedule requested.',
    needsReview: true,
    messages: [
      { from: 'customer', text: 'can i get a refund for saturday, weather looks bad', time: '08:10 AM' },
      { from: 'caye', text: 'Escalated to founder — refund requests go through Karenda directly.', time: '08:15 AM' },
    ],
  },
]

export default function CommandConversations() {
  const [tab, setTab] = useState<'all' | 'review'>('all')
  const [activeId, setActiveId] = useState<string>(MOCK_CONVERSATIONS[0].id)
  const [query, setQuery] = useState('')

  const reviewCount = MOCK_CONVERSATIONS.filter((c) => c.needsReview).length
  const list = MOCK_CONVERSATIONS
    .filter((c) => (tab === 'review' ? c.needsReview : true))
    .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
  const active = MOCK_CONVERSATIONS.find((c) => c.id === activeId) ?? list[0]

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
            placeholder="Search chat or phone…"
            style={{
              width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8, padding: '7px 10px', fontSize: 12.5, color: '#f5f5f4', outline: 'none',
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                background: active?.id === c.id ? 'rgba(255,255,255,0.06)' : 'transparent',
                borderRadius: 10, padding: '10px 10px', marginBottom: 2,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color: CHANNEL_COLOR[c.channel], border: `1px solid ${CHANNEL_COLOR[c.channel]}66`, borderRadius: 999, padding: '1px 6px' }}>
                  {c.channel}
                </span>
              </div>
              <p style={{ fontSize: 11.5, color: 'rgba(245,245,244,0.4)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.preview}
              </p>
              {c.needsReview && (
                <span style={{ fontSize: 9, fontWeight: 700, color: '#ff8a6b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Reviewing
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Thread detail ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, overflowY: 'auto' }}>
        {active && (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{active.name}</div>
            <div style={{ fontSize: 11, color: 'rgba(245,245,244,0.35)', marginBottom: 14 }}>
              Channel: {active.channel}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {active.messages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    alignSelf: m.from === 'caye' ? 'flex-end' : 'flex-start',
                    maxWidth: '80%',
                    background: m.from === 'caye' ? 'rgba(125,201,203,0.12)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 12,
                    padding: '8px 12px',
                  }}
                >
                  <p style={{ fontSize: 13, lineHeight: 1.4 }}>{m.text}</p>
                  <span style={{ fontSize: 10, color: 'rgba(245,245,244,0.35)' }}>{m.time}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
