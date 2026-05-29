'use client'

import { useEffect, useState } from 'react'
import { getSupabase } from '@/lib/supabase'

interface PingRow {
  id: string
  kind: string
  status: string
  sent_at: string | null
  created_at: string
}

/**
 * Renders inside the held-conversation detail view. Shows whether Caye has
 * pinged the operator on WhatsApp about THIS conversation, and surfaces
 * resolution when the conversation is closed.
 */
export default function WhatsAppPingIndicator({
  conversationId,
  resolved,
  resolvedAt,
}: {
  conversationId: string | null
  resolved: boolean
  resolvedAt?: string | null
}) {
  const [rows, setRows] = useState<PingRow[]>([])

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    async function load() {
      const supabase = getSupabase()
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(`/api/caye/whatsapp/activity?conversation_id=${conversationId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok || cancelled) return
      const data = await res.json()
      setRows(data.rows ?? [])
    }
    load()
    return () => {
      cancelled = true
    }
  }, [conversationId])

  const sent = rows.find((r) => r.status === 'sent')
  if (!sent) return null

  return (
    <div
      style={{
        fontSize: 11,
        color: 'var(--tc-ink-faint, #8a8a8a)',
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span>Caye also pinged you on WhatsApp {relativeAgo(sent.sent_at ?? sent.created_at)}.</span>
      {resolved && (
        <span style={{ color: 'var(--tc-accent, #0FB5A1)', fontWeight: 500 }}>
          · Resolved {resolvedAt ? formatShort(resolvedAt) : ''}
        </span>
      )}
    </div>
  )
}

function relativeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatShort(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
