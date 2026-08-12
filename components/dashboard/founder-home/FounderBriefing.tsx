'use client'

import { useFounderIdentity } from '@/lib/useFounderIdentity'
import { useMediaQuery } from '@/lib/useMediaQuery'
import type { CommandOverview } from '@/lib/useCommandOverview'
import { CayeCore, type CayeState } from './CayeCore'

const LABEL_COLOR = '#71717a'
const GRADIENT = 'linear-gradient(90deg, #0766A3, #4EBECE, #FFE4AF)'

function timeGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

// Every number here comes from CommandOverview (real bookings/escalations
// for the selected workspace) — deliberately not the richer "14
// conversations, 8 leads followed up" framing from the reference mockup,
// because no aggregate like that exists yet. Said plainly with what's
// actually known rather than invented to match the copy.
function summarize(data: CommandOverview | null): string {
  if (!data) return 'Pulling the latest…'
  const bookings = data.bookings.length
  const pending = data.pending_escalation_count
  const bookingsPart = bookings === 0
    ? 'No new bookings this week yet'
    : `${bookings} booking${bookings === 1 ? '' : 's'} this week`
  if (!data.caye_active) {
    return `${bookingsPart}. I'm paused for this workspace right now.`
  }
  if (pending === 0) {
    return `${bookingsPart}. Nothing needs you right now.`
  }
  return `${bookingsPart}. I need you for ${pending} thing${pending === 1 ? '' : 's'}.`
}

function headline(data: CommandOverview | null): string {
  if (!data) return 'Getting oriented.'
  if (!data.caye_active) return 'Paused.'
  return data.pending_escalation_count === 0 ? "Everything's handled." : 'One thing needs you.'
}

function statusCaption(data: CommandOverview | null): string {
  if (!data) return '—'
  if (!data.caye_active) return 'Paused'
  return data.pending_escalation_count > 0 ? `${data.pending_escalation_count} awaiting review` : 'Working normally'
}

export default function FounderBriefing({
  data, workspaceName, state,
}: {
  data: CommandOverview | null
  workspaceName: string
  state: CayeState
}) {
  const { firstName } = useFounderIdentity()
  const narrow = useMediaQuery('(max-width: 780px)')

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 32,
      padding: '28px 8px 32px', flexWrap: 'wrap',
    }}>
      <div style={{ minWidth: 260, maxWidth: 460 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
          letterSpacing: '0.1em', textTransform: 'uppercase', color: '#4EBECE', marginBottom: 10,
        }}>
          {timeGreeting()}
        </div>
        <h1 style={{
          fontSize: 30, fontWeight: 600, fontFamily: 'var(--font-display)',
          margin: 0, lineHeight: 1.15, letterSpacing: '-0.01em', color: '#f4f4f5',
        }}>
          {timeGreeting()}{firstName ? `, ${firstName}` : ''}.
        </h1>
        <h2 style={{
          fontSize: 30, fontWeight: 600, fontFamily: 'var(--font-display)',
          margin: '2px 0 14px', lineHeight: 1.15, letterSpacing: '-0.01em',
          backgroundImage: GRADIENT, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
        }}>
          {headline(data)}
        </h2>
        <p style={{ fontSize: 14, color: '#a1a1aa', lineHeight: 1.6, margin: 0 }}>
          {summarize(data)} <span style={{ color: LABEL_COLOR }}>({workspaceName})</span>
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <CayeCore state={state} size={narrow ? 88 : 132} />
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.08em', color: '#f4f4f5',
          }}>
            CAYE · {data?.caye_active ? 'ACTIVE' : 'PAUSED'}
          </div>
          <div style={{ fontSize: 11.5, color: LABEL_COLOR, marginTop: 2 }}>{statusCaption(data)}</div>
        </div>
      </div>
    </div>
  )
}
