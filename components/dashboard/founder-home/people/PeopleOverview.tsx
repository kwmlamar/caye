'use client'

import { TEXT, TEXT_QUIET, GOLD } from '../../surface'
import type { PersonSummary } from '@/lib/people'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Same editorial-strip pattern as Memory's MemoryOverview / Home's
// BusinessPulse — real counts, generous spacing, no metric cards.
function Metric({ value, label, tone = 'neutral' }: { value: string; label: string; tone?: 'neutral' | 'gold' }) {
  return (
    <div>
      <div style={{
        fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600,
        color: tone === 'gold' ? GOLD : TEXT, fontVariantNumeric: 'tabular-nums', marginBottom: 5, letterSpacing: '-0.01em',
      }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: TEXT_QUIET }}>{label}</div>
    </div>
  )
}

/**
 * Replaces the old three-card CONTACTS / ACTIVE THIS WEEK / FLAGGED grid —
 * counts adapt to workspace kind rather than showing the same fixed labels
 * everywhere, since "customers" and "prospects" aren't the same thing and
 * pretending otherwise is exactly the "second CRM" shape this redesign is
 * meant to avoid.
 */
export default function PeopleOverview({ people, isSales }: { people: PersonSummary[]; isSales: boolean }) {
  const activeThisWeek = people.filter(
    (p) => p.lastInteractionAt && Date.now() - new Date(p.lastInteractionAt).getTime() < ONE_WEEK_MS
  ).length
  const needsYou = people.filter((p) => p.needsYou).length

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 52, rowGap: 16, padding: '0 2px' }}>
      {isSales ? (
        <>
          <Metric value={String(people.length)} label="Prospects" />
          <Metric value={String(people.filter((p) => p.state === 'engaged').length)} label="Engaged" />
          <Metric value={String(activeThisWeek)} label="Active this week" />
          <Metric value={String(people.filter((p) => p.state === 'converted').length)} label="Converted" />
        </>
      ) : (
        <>
          <Metric value={String(people.length)} label="People" />
          <Metric value={String(people.filter((p) => p.state === 'customer' || p.state === 'returning_customer').length)} label="Customers" />
          <Metric value={String(activeThisWeek)} label="Active this week" />
        </>
      )}
      {needsYou > 0 && <Metric value={String(needsYou)} label={needsYou === 1 ? 'Needs you' : 'Need you'} tone="gold" />}
    </div>
  )
}
