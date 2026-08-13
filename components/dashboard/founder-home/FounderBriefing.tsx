'use client'

import { useState } from 'react'
import { useFounderIdentity } from '@/lib/useFounderIdentity'
import { getSession } from '@/lib/supabase'
import type { CommandOverview } from '@/lib/useCommandOverview'
import type { TodayStats } from '@/lib/useTodayStats'
import { CayeCore, type CayeState } from './CayeCore'
import AttentionCard from './AttentionCard'

const LABEL_COLOR = '#71717a'
const GRADIENT = 'linear-gradient(90deg, #0766A3, #4EBECE, #FFE4AF)'

function timeGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

// Every clause here is backed by a real field. No "8 leads followed up" —
// there's no signal for what counts as a lead follow-up, so it's left out
// rather than guessed at.
function summarize(data: CommandOverview | null, today: TodayStats | null): string {
  if (!data) return 'Pulling the latest…'
  const clauses: string[] = []
  const bookings = data.bookings.length
  clauses.push(bookings === 0 ? 'No new bookings this week yet' : `${bookings} booking${bookings === 1 ? '' : 's'} this week`)
  if (today && today.customersAnswered > 0) {
    clauses.push(`answered ${today.customersAnswered} customer${today.customersAnswered === 1 ? '' : 's'} today`)
  }
  let sentence = clauses.join(', ') + '.'
  sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1)
  if (!data.caye_active) return `${sentence} I'm paused for this workspace right now.`
  return sentence
}

function headline(data: CommandOverview | null): string {
  if (!data) return 'Getting oriented.'
  if (!data.caye_active) return 'Paused.'
  if (data.pending_escalation_count > 0) {
    return data.pending_escalation_count === 1 ? 'One thing needs you.' : `${data.pending_escalation_count} things need you.`
  }
  if (data.bookings.length === 0) return "Quiet day. I've got it."
  return "Everything's handled."
}

function DeploymentLink({ workspaceId, active, onToggled }: { workspaceId: string; active: boolean; onToggled: () => void }) {
  const [busy, setBusy] = useState(false)
  async function handleClick() {
    if (busy) return
    setBusy(true)
    try {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch('/api/founder/caye-toggle', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ workspaceId, active: !active }),
      })
      if (res.ok) onToggled()
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      onClick={handleClick}
      disabled={busy}
      style={{
        border: 'none', background: 'transparent', cursor: busy ? 'default' : 'pointer',
        fontSize: 11, fontFamily: 'var(--font-mono)', color: active ? '#71717a' : '#34d399',
        textDecoration: 'underline', textUnderlineOffset: 3, opacity: busy ? 0.5 : 1, padding: 0,
      }}
    >
      {busy ? '···' : active ? 'Pause' : 'Resume'}
    </button>
  )
}

export default function FounderBriefing({
  data, today, workspaceId, workspaceName, state, onReviewAttention, onDeploymentToggled,
}: {
  data: CommandOverview | null
  today: TodayStats | null
  workspaceId: string
  workspaceName: string
  state: CayeState
  onReviewAttention: (conversationId: string | null) => void
  onDeploymentToggled: () => void
}) {
  const { firstName } = useFounderIdentity()

  return (
    <div className="caye-hero" style={{
      display: 'flex', alignItems: 'center', gap: 40, padding: '36px 4px 12px', flexWrap: 'wrap',
    }}>
      <div className="caye-hero-text" style={{ flex: '1 1 380px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.1em', textTransform: 'uppercase', color: '#4EBECE', marginBottom: 10,
          }}>
            {timeGreeting()}
          </div>
          <h1 style={{
            fontSize: 32, fontWeight: 600, fontFamily: 'var(--font-display)',
            margin: 0, lineHeight: 1.15, letterSpacing: '-0.01em', color: '#f4f4f5',
          }}>
            {timeGreeting()}{firstName ? `, ${firstName}` : ''}.
          </h1>
          <h2 style={{
            fontSize: 32, fontWeight: 600, fontFamily: 'var(--font-display)',
            margin: '2px 0 14px', lineHeight: 1.15, letterSpacing: '-0.01em',
            backgroundImage: GRADIENT, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
          }}>
            {headline(data)}
          </h2>
          <p style={{ fontSize: 14.5, color: '#a1a1aa', lineHeight: 1.6, margin: 0, maxWidth: 420 }}>
            {summarize(data, today)}
          </p>
        </div>

        {data && (
          <AttentionCard escalations={data.escalations} onReview={onReviewAttention} />
        )}
      </div>

      <div className="caye-hero-orb" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, flexShrink: 0, margin: '0 auto' }}>
        <CayeCore state={state} size={340} />
        <div style={{ textAlign: 'center', marginTop: -12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', color: '#f4f4f5' }}>
            CAYE · {data?.caye_active ? 'ACTIVE' : 'PAUSED'}
          </div>
          <div style={{ fontSize: 11.5, color: LABEL_COLOR, marginTop: 3, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
            <span>{!data ? '—' : !data.caye_active ? 'Paused' : data.pending_escalation_count > 0 ? 'Waiting on you' : 'Working normally'}</span>
            {data && <span style={{ color: '#3f3f46' }}>·</span>}
            {data && <DeploymentLink workspaceId={workspaceId} active={data.caye_active} onToggled={onDeploymentToggled} />}
          </div>
        </div>
      </div>
    </div>
  )
}
