'use client'

import { useState, useEffect, useRef } from 'react'
import type { Escalation } from '@/lib/useCommandOverview'
import { summarizeEscalation, sortEscalationsByPriority, CATEGORY_TOPIC_LABEL } from '@/lib/attention-briefing'
import { GOLD, TEXT, TEXT_QUIET } from '../surface'

/**
 * "What does Caye need from me?" — one decision at a time, in plain
 * language. Open caye_escalations rows already ARE real founder decisions,
 * so this reads the real record, but not verbatim: internal_context is
 * mostly plain-English (evidence.ts's ownerNoteFor) but for the
 * escalate_to_team tool path it's model-generated text passed straight
 * through, and jargon has reached this card live before (2026-08-11/12).
 * summarizeEscalation (lib/attention-briefing.ts) is the backstop — same
 * "irreversible-ish surface needs a check in code, not just a prompt"
 * reasoning as operator-text-guard.ts, applied here because a founder
 * skimming Home in five seconds won't catch a leak the way a careful
 * reader of a WhatsApp thread might.
 *
 * The full record — category, route_to, raw internal_context — stays one
 * click away in Inbox/CayeHandoff. This card is the summary, not the only
 * copy.
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
  const open = sortEscalationsByPriority(
    escalations.filter((e) => !e.owner_responded_at && !e.expired_at)
  )
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

  const { body, decision } = summarizeEscalation(primary)
  const topic = primary.booking_meta?.service_name
    || (primary.category && CATEGORY_TOPIC_LABEL[primary.category])
    || 'Something to review'
  const who = primary.customer_name || 'A customer'
  const meta = primary.booking_meta
    // booking_date is a bare YYYY-MM-DD — pin UTC so it always renders as
    // the calendar date it names, not shifted a day by the viewer's
    // timezone (found while fixing the identical bug in lib/people.ts).
    ? `${primary.booking_meta.number_of_people} guest${primary.booking_meta.number_of_people === 1 ? '' : 's'} · ${new Date(`${primary.booking_meta.booking_date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}`
    : null
  const rest = open.slice(1)

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
          Needs you
        </span>
      </div>

      <div>
        <p style={{ fontSize: 14.5, fontWeight: 600, color: TEXT, margin: 0, lineHeight: 1.4 }}>
          {who} <span style={{ fontWeight: 400, color: TEXT_QUIET }}>·</span> {topic}
        </p>
        {meta && (
          <p style={{ fontSize: 11.5, color: TEXT_QUIET, margin: '3px 0 0' }}>{meta}</p>
        )}
      </div>

      <p style={{ fontSize: 13.5, color: TEXT, lineHeight: 1.55, margin: 0, opacity: 0.9 }}>{body}</p>
      {decision && (
        <p style={{ fontSize: 13.5, color: GOLD, lineHeight: 1.5, margin: 0, fontWeight: 600 }}>{decision}</p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={() => onReview(primary.conversation_id)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            padding: '7px 16px', borderRadius: 9, border: 'none', cursor: 'pointer',
            fontSize: 12.5, fontWeight: 600, color: GOLD,
            background: hover ? 'rgba(255,228,175,0.22)' : 'rgba(255,228,175,0.13)',
            transition: 'background 0.15s ease',
          }}
        >
          Review conversation
        </button>
        {rest.length > 0 && (
          <button
            onClick={() => onReview(rest[0].conversation_id)}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
              fontSize: 12, color: TEXT_QUIET, textDecoration: 'underline', textUnderlineOffset: 2,
            }}
          >
            {rest.length === 1 ? '1 more needs you →' : `${rest.length} more need you →`}
          </button>
        )}
      </div>
    </div>
  )
}
