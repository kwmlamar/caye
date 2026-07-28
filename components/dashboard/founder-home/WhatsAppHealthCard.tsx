'use client'

import { useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from '@/components/dashboard/founder-home/CayeLoadingPulse'
import { Pill } from '@/components/dashboard/founder-home/console-ui'
import type { WhatsAppHealthRow } from '@/app/api/founder/whatsapp-health/route'

const CARD_BG = '#1a1a1e'
const LABEL_COLOR = '#71717a'

function fmtAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(ms / (60 * 60 * 1000))
  if (hours < 1) return '<1h ago'
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Cross-workspace "is Caye's WhatsApp channel actually reaching operators"
 * check. Built after discovering 2026-07-27 that 93 operator pings over 14
 * days produced zero confirmed deliveries, with nothing in the dashboard
 * that would have surfaced it — caye_outbound_queue.status='sent' only
 * ever meant the API call to Meta succeeded, never that a phone received
 * anything. See briefs/whatsapp-delivery-reliability.md.
 *
 * Only renders workspaces with whatsapp_outbound_enabled=true; hides
 * itself entirely when every one of them has at least one confirmed
 * delivery in the lookback window and no failure streak — a quiet channel
 * shouldn't compete for attention with the metrics that matter day to day.
 */
export default function WhatsAppHealthCard() {
  const [rows, setRows] = useState<WhatsAppHealthRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/whatsapp-health', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const json = await res.json()
      if (cancelled) return
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setRows(json.rows ?? [])
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (error) {
    return (
      <div style={{ background: CARD_BG, borderRadius: 16, padding: 16, fontSize: 12.5, color: '#fb7185' }}>
        WhatsApp health: {error}
      </div>
    )
  }
  if (rows === null) {
    return <div style={{ background: CARD_BG, borderRadius: 16, padding: 16 }}><CayeLoadingPulse size={14} /></div>
  }

  const flagged = rows.filter((r) => r.noConfirmedDeliveries || r.failureStreak > 0 || r.unreachable)
  if (flagged.length === 0) return null

  return (
    <div style={{ background: CARD_BG, borderRadius: 16, overflow: 'hidden' }}>
      <div style={{
        padding: '10px 16px', background: 'rgba(251,113,133,0.06)',
        fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em', textTransform: 'uppercase', color: '#fb7185',
      }}>
        WhatsApp delivery — needs attention
      </div>
      <div>
        {flagged.map((r) => (
          <div key={r.workspaceId} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
            boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.04)',
          }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.businessName}
            </span>
            <span style={{ fontSize: 11.5, color: LABEL_COLOR, fontVariantNumeric: 'tabular-nums' }}>
              last confirmed {fmtAgo(r.lastConfirmedAt)}
            </span>
            {r.failureStreak > 0 && <Pill color="#fb7185" label={`${r.failureStreak} failed in a row`} />}
            {r.unreachable && <Pill color="#fb7185" label="Unreachable" />}
            {r.noConfirmedDeliveries && !r.unreachable && r.failureStreak === 0 && (
              <Pill color="#FFE4AF" label="No confirmed deliveries" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
