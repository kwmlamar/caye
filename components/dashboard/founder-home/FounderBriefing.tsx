'use client'

import { useState } from 'react'
import { useFounderIdentity } from '@/lib/useFounderIdentity'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { getSession } from '@/lib/supabase'
import type { CommandOverview } from '@/lib/useCommandOverview'
import type { TodayStats } from '@/lib/useTodayStats'
import { CayePresence, type CayePresenceState } from '@/components/caye-presence/CayePresence'
import AttentionCard from './AttentionCard'
import { AQUA, TEXT, TEXT_MUTED, TEXT_QUIET, GRADIENT, EMERALD } from '../surface'

const LABEL_COLOR = TEXT_QUIET

// Caye as a primary visual anchor of the hero, not a small status
// indicator — sized so the *visible* sphere (not just its Canvas box)
// reaches ~650px on wide desktop. That visible size is a function of both
// this box (CayePresence `size`) and how much of the box the sphere fills
// (ParticleSphere.tsx's BASE_RADIUS/camera framing, tuned separately to
// ~73% fill) — see the right-column grid share below, which had to grow
// too, since an 880px box no longer fits half of a 50/50 split. Reuses
// FounderHome.tsx's existing 1100/780 breakpoints (the 1100 split is also
// where the hero stacks to one column) rather than inventing new ones;
// 1600 is the one new threshold, purely for this size tier.
const HERO_ORB_SIZE_WIDE = 880 // >=1600px — visible sphere ≈ 880*0.73 ≈ 640px
const HERO_ORB_SIZE_DESKTOP = 710 // 1100–1599px — visible ≈ 520px
const HERO_ORB_SIZE_TABLET = 460 // 780–1099px (stacked layout) — visible ≈ 335px
const HERO_ORB_SIZE_MOBILE = 230 // <780px — kept small and layout-safe
// CayePresence's Canvas box doesn't fill edge-to-edge — ParticleSphere.tsx
// deliberately leaves ~11.35% empty on each side (measured: a 680px
// visible sphere inside an 880px box) so the particle silhouette clears
// the camera frustum without clipping. That empty margin is invisible to
// CSS, so no amount of container/grid alignment moves the *visible*
// sphere any closer to the row's top than this — the box's edges just
// aren't where the particles are. Compensated below with matching
// negative margins on the CayePresence wrapper, which pull the box (and
// its internal padding) up/in without touching the 3D framing, so the
// visible particles — not just the box — align with the row's top and
// the status text sits flush under them.
const CANVAS_INNER_PADDING_RATIO = 0.1135

/** The hero orb's activity signal — real fields, computed in FounderHome
 *  (channel reauth needed / an escalation is open / a fetch or route
 *  transition is in flight / none of the above). Named and owned here
 *  rather than by whatever renders the orb, since it predates and outlives
 *  any one visual (previously CayeCore, now CayePresence). */
export type CayeActivityState = 'idle' | 'working' | 'attention' | 'error'

// CayePresence only speaks idle/listening/thinking/speaking — there's no
// "needs you" or "channel broken" visual language, and inventing one here
// would mean forking the shared shader/motion component for one page.
// `attention` and `error` already have real surfaces of their own on this
// page (AttentionCard above, and the "Waiting on you" status line below)
// so they fall back to idle on the orb itself rather than being
// misrepresented as thinking/speaking. `working` (a fetch or route
// transition in flight) is the one honest match for `thinking`.
function toPresenceState(state: CayeActivityState): CayePresenceState {
  return state === 'working' ? 'thinking' : 'idle'
}

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
        fontSize: 11, fontFamily: 'var(--font-mono)', color: active ? TEXT_QUIET : EMERALD,
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
  state: CayeActivityState
  onReviewAttention: (conversationId: string | null) => void
  onDeploymentToggled: () => void
}) {
  const { firstName } = useFounderIdentity()
  const isWide = useMediaQuery('(min-width: 1600px)')
  const isTablet = useMediaQuery('(max-width: 1099px)')
  const isMobile = useMediaQuery('(max-width: 779px)')
  const orbSize = isMobile
    ? HERO_ORB_SIZE_MOBILE
    : isTablet
    ? HERO_ORB_SIZE_TABLET
    : isWide
    ? HERO_ORB_SIZE_WIDE
    : HERO_ORB_SIZE_DESKTOP
  const canvasInnerPadding = Math.round(orbSize * CANVAS_INNER_PADDING_RATIO)

  return (
    <div className="caye-hero" style={{
      // Grid, not flex — two genuine halves (left = status, right = Caye)
      // so the orb centers in its own column at any width instead of a
      // flex-grow text column leaving a flex-shrink:0 orb pinned to the
      // edge with a growing gap of dead space between them on wide
      // viewports. The right column now carries a larger share (1.6fr vs
      // 1fr) — a flat 50/50 split left too little room for an 880px orb
      // to sit centered with real padding; the left column's actual
      // content (headline, attention card) is comfortably narrower than
      // even its reduced share, so this doesn't touch what's rendered
      // there. minmax floor keeps both sides readable before the 1100px
      // breakpoint collapses to one column below.
      //
      // alignItems: start — with alignItems:center, the row's height is
      // set by the orb column (~950px incl. status text), so the much
      // shorter text column was centered against *that*, sitting ~215px
      // below the row's top regardless of this container's own padding
      // (which only shifts where the row starts, not where a centered
      // item sits within it). That's what was opening the big gap under
      // the header. Both columns now start at the row's top edge, with
      // matching small paddingTop values (see below) so the greeting and
      // the sphere read as beginning at the same line.
      display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 1.6fr)',
      alignItems: 'start', gap: 48, padding: '8px 4px 16px',
    }}>
      <div className="caye-hero-text" style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0, paddingTop: 8 }}>
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
            letterSpacing: '0.1em', textTransform: 'uppercase', color: AQUA, marginBottom: 12,
          }}>
            {timeGreeting()}
          </div>
          <h1 style={{
            fontSize: 34, fontWeight: 600, fontFamily: 'var(--font-display)',
            margin: 0, lineHeight: 1.15, letterSpacing: '-0.015em', color: TEXT,
          }}>
            {timeGreeting()}{firstName ? `, ${firstName}` : ''}.
          </h1>
          <h2 style={{
            fontSize: 34, fontWeight: 600, fontFamily: 'var(--font-display)',
            margin: '2px 0 16px', lineHeight: 1.15, letterSpacing: '-0.015em',
            backgroundImage: GRADIENT, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
          }}>
            {headline(data)}
          </h2>
          <p style={{ fontSize: 14.5, color: TEXT_MUTED, lineHeight: 1.65, margin: 0, maxWidth: 420 }}>
            {summarize(data, today)}
          </p>
        </div>

        {data && (
          <AttentionCard escalations={data.escalations} onReview={onReviewAttention} />
        )}
      </div>

      <div className="caye-hero-orb" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifySelf: 'center', paddingTop: 8 }}>
        {/* Negative top/bottom margins crop the Canvas box's own empty
            padding out of the flow — see CANVAS_INNER_PADDING_RATIO above.
            Without this, the box's top/bottom edges (not the visible
            particles) are what alignment and the status gap measure
            against, leaving both too far from the sphere's real edges. */}
        <div style={{ marginTop: -canvasInnerPadding, marginBottom: -canvasInnerPadding }}>
          <CayePresence state={toPresenceState(state)} size={orbSize} interactive />
        </div>
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em', color: TEXT }}>
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
