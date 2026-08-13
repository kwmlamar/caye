'use client'

import { useState, useEffect, useRef } from 'react'
import type { Escalation } from '@/lib/useCommandOverview'
import { GOLD, TEXT } from '../surface'

/**
 * "Surface the decision, not merely its existence." Open caye_escalations
 * rows already ARE real founder decisions — a customer asked something
 * Caye didn't want to guess about — so this reads the real record
 * (internal_context: a 2-5 sentence handoff note Caye is already
 * prompted to write in plain language, ending in a concrete yes/no —
 * see the escalate_to_team tool schema in lib/caye-reply.ts) rather than
 * a generic count. Renders nothing when there's genuinely nothing open.
 *
 * Warm, not alarming: no bordered gold box. A faint tinted surface, a
 * localized soft glow, and a quiet gold action — she's asking for a
 * judgment call, not raising an alarm.
 *
 * When the escalation resolves (owner_responded_at gets set — happens
 * elsewhere, e.g. the owner replying in Inbox) the next command-overview
 * poll drops it from `escalations`. Rather than just vanishing, this
 * plays a brief fade-and-settle exit and only then unmounts, so the
 * page reflow reads as "handled" rather than a layout jump.
 */
export default function AttentionCard({ escalations, onReview }: {
  escalations: Escalation[]
  onReview: (conversationId: string | null) => void
}) {
  const [hover, setHover] = useState(false)
  const open = escalations
    .filter((e) => !e.owner_responded_at && !e.expired_at)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  const hasOpen = open.length > 0

  const [mounted, setMounted] = useState(hasOpen)
  const wasOpenRef = useRef(hasOpen)
  useEffect(() => {
    if (hasOpen) {
      setMounted(true)
      wasOpenRef.current = true
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false
      const t = setTimeout(() => setMounted(false), 320)
      return () => clearTimeout(t)
    }
  }, [hasOpen])

  if (!mounted) return null
  // Still rendering during the exit window even though `open` is now
  // empty — hold the last known primary rather than reading open[0].
  const primary = open[0] ?? escalations.find((e) => !e.owner_responded_at) ?? escalations[0]
  if (!primary) return null
  const detail = primary.internal_context
    || primary.customer_facing_message
    || (primary.category ? `Something about ${primary.category} I'd rather not guess on.` : "Something I'd rather not guess on.")

  return (
    <div style={{
      background: 'rgba(255,228,175,0.035)', borderRadius: 16,
      boxShadow: '0 1px 0 rgba(255,255,255,0.03) inset, 0 0 44px -16px rgba(255,228,175,0.3)',
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 440,
      animation: hasOpen ? 'caye-view-in 0.25s ease-out' : 'caye-resolve-out 0.3s ease forwards',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: GOLD, boxShadow: `0 0 6px ${GOLD}88` }} />
        <span style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', textTransform: 'uppercase', color: GOLD }}>
          Needs you{open.length > 1 ? ` · +${open.length - 1} more` : ''}
        </span>
      </div>
      <p style={{ fontSize: 14, color: TEXT, lineHeight: 1.55, margin: 0, opacity: 0.92 }}>{detail}</p>
      <button
        onClick={() => onReview(primary.conversation_id)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          alignSelf: 'flex-start', padding: '7px 16px', borderRadius: 9, border: 'none', cursor: 'pointer',
          fontSize: 12.5, fontWeight: 600, color: GOLD,
          background: hover ? 'rgba(255,228,175,0.22)' : 'rgba(255,228,175,0.13)',
          transition: 'background 0.15s ease',
        }}
      >
        Review conversation
      </button>
    </div>
  )
}
