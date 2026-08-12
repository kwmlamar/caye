'use client'

import { useState, useEffect, useRef } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { getSession } from '@/lib/supabase'

const CARD_BG = '#1a1a1e'
const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'
const TONE_COLOR = { positive: '#34d399', neutral: '#4EBECE', alert: '#fb7185' } as const

const POLL_MS = 20_000
const CYCLE_MS = 5_000

interface LiveEvent {
  id: number
  at: string
  type: string
  label: string
  tone: keyof typeof TONE_COLOR
}

function relTime(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function EventChip({ event, now, align }: { event: LiveEvent; now: number; align: 'left' | 'right' }) {
  return (
    <div
      key={event.id}
      style={{
        display: 'flex', flexDirection: 'column', gap: 3,
        background: 'rgba(255,255,255,0.045)', border: `1px solid ${CARD_BORDER}`,
        borderRadius: 12, padding: '9px 13px', minWidth: 0, maxWidth: 230,
        animation: `caye-pulse-chip-in-${align} 0.35s ease-out`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: TONE_COLOR[event.tone], flexShrink: 0 }} />
        <span style={{
          fontSize: 12.5, fontWeight: 600, color: '#f4f4f5',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {event.label}
        </span>
      </div>
      <span style={{ fontSize: 11, color: LABEL_COLOR, fontFamily: 'var(--font-mono)', paddingLeft: 13 }}>
        {relTime(event.at, now)}
      </span>
    </div>
  )
}

// A pulsing orb with two real-event chips drifting on either side —
// FounderHome's "alive" strip. Reads from /api/founder/live-events
// (workspace_events), the same canonical stream the WhatsApp digest reads,
// so what's shown here actually happened rather than being decorative.
export default function CayeLivePulse({ workspaceId }: { workspaceId: string }) {
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [cursor, setCursor] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const latestIdRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const { session } = await getSession()
      if (!session || cancelled) return
      try {
        const res = await fetch(`/api/founder/live-events?workspaceId=${workspaceId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok || cancelled) return
        const json = await res.json()
        const next: LiveEvent[] = json.events ?? []
        setEvents(next)
        // A genuinely new latest event jumps the cycle straight to it
        // instead of waiting for the rotation to come back around.
        if (next[0] && next[0].id !== latestIdRef.current) {
          latestIdRef.current = next[0].id
          setCursor(0)
        }
      } catch {
        // Silent — a missed poll just leaves the last known events showing.
      }
    }
    poll()
    const interval = setInterval(poll, POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [workspaceId])

  useEffect(() => {
    if (events.length < 2) return
    const interval = setInterval(() => setCursor((c) => (c + 1) % events.length), CYCLE_MS)
    return () => clearInterval(interval)
  }, [events.length])

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  const right = events.length > 0 ? events[cursor % events.length] : null
  const left = events.length > 1 ? events[(cursor + 1) % events.length] : null

  return (
    <div style={{
      flexShrink: 0, position: 'relative', overflow: 'hidden',
      background: CARD_BG, borderRadius: 18, padding: '18px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, minHeight: 96,
    }}>
      <style>{`
        @keyframes caye-pulse-ring {
          0%   { transform: scale(0.65); opacity: 0.5; }
          100% { transform: scale(1.9); opacity: 0; }
        }
        @keyframes caye-pulse-chip-in-left {
          from { opacity: 0; transform: translateX(6px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes caye-pulse-chip-in-right {
          from { opacity: 0; transform: translateX(-6px); }
          to   { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .caye-pulse-ring { animation: none !important; opacity: 0.35 !important; }
          [style*="caye-pulse-chip-in"] { animation: none !important; }
        }
      `}</style>

      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', minWidth: 0 }}>
        {left && <EventChip event={left} now={now} align="left" />}
      </div>

      <div style={{ position: 'relative', width: 56, height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="caye-pulse-ring" aria-hidden style={{
          position: 'absolute', width: 44, height: 44, borderRadius: '50%',
          border: '1.5px solid #4EBECE', animation: 'caye-pulse-ring 2.6s ease-out infinite',
        }} />
        <span className="caye-pulse-ring" aria-hidden style={{
          position: 'absolute', width: 44, height: 44, borderRadius: '50%',
          border: '1.5px solid #4EBECE', animation: 'caye-pulse-ring 2.6s ease-out infinite', animationDelay: '1.3s',
        }} />
        <div style={{
          position: 'relative', width: 44, height: 44, borderRadius: '50%',
          background: 'radial-gradient(circle at 35% 30%, #0f2a33, #111113)',
          boxShadow: '0 0 22px rgba(78,190,206,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <CayeMark size={24} />
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start', minWidth: 0 }}>
        {right && <EventChip event={right} now={now} align="right" />}
      </div>

      {events.length === 0 && (
        <span style={{
          position: 'absolute', bottom: 12, fontSize: 11, color: LABEL_COLOR,
          fontFamily: 'var(--font-mono)', letterSpacing: '0.04em',
        }}>
          NO RECENT ACTIVITY
        </span>
      )}
    </div>
  )
}
