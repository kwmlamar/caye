'use client'

import { useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { FreightWorkflowCard } from '@/components/dashboard/command-conversations/FreightWorkflowCard'

type Conversation = { id: string; customerName: string | null; customerId: string; subject: string | null; lastMessageAt: string | null; freightStatus: string | null }

export default function FreightReviewInbox({ workspaceId }: { workspaceId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const { session } = await getSession()
      if (!session) return
      const response = await fetch(`/api/founder/freight-workflow?${new URLSearchParams({ workspaceId })}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await response.json() as { conversations?: Conversation[]; error?: string }
      if (!response.ok) return setError(json.error ?? 'Could not load freight review')
      setConversations(json.conversations ?? [])
      const pending = json.conversations?.find(item => item.freightStatus && item.freightStatus !== 'SENT')
      if (pending) setSelected(pending.id)
    })()
  }, [workspaceId])

  return <div style={{ display: 'flex', height: '100%', minHeight: 0, background: '#fff', color: '#0e1a1a' }}>
    <div style={{ width: 310, borderRight: '1px solid rgba(14,26,26,.09)', overflowY: 'auto', padding: 18 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Freight review</h1>
      <p style={{ fontSize: 12, opacity: .55, marginBottom: 16 }}>Select the requesting email, review the generated PDF, then approve the send.</p>
      {error && <p style={{ color: '#b91c1c', fontSize: 12 }}>{error}</p>}
      {conversations.map(item => <button key={item.id} onClick={() => setSelected(item.id)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 9, padding: '10px 9px', marginBottom: 4, cursor: 'pointer', background: selected === item.id ? 'rgba(14,26,26,.07)' : 'transparent', color: 'inherit' }}>
        <div style={{ fontSize: 13, fontWeight: 650 }}>{item.customerName ?? item.customerId}</div>
        <div style={{ fontSize: 11, opacity: .55, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.subject ?? 'No subject'}</div>
      </button>)}
    </div>
    <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingTop: 24 }}>
      {selected ? <FreightWorkflowCard workspaceId={workspaceId} conversationId={selected} onPrepared={() => undefined} /> : <p style={{ padding: 24, opacity: .55 }}>Choose a Gmail conversation to check for a freight document request.</p>}
    </div>
  </div>
}
