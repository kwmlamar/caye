'use client'

import type { CommandOverview } from '@/lib/useCommandOverview'
import type { TodayStats } from '@/lib/useTodayStats'
import { TEXT, TEXT_QUIET } from '../surface'

// Level 2: real, secondary, small. Deployment status lives in the hero
// (it's Caye's own state, not a business metric) and "needs review" is
// the AttentionCard itself, not a redundant count — so this strip only
// carries numbers that don't duplicate something already shown elsewhere.
// Editorial, not a metric-card row: generous gap does the separating,
// no vertical rules.
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{
        fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600,
        color: TEXT, fontVariantNumeric: 'tabular-nums', marginBottom: 5, letterSpacing: '-0.01em',
      }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: TEXT_QUIET }}>{label}</div>
    </div>
  )
}

export default function BusinessPulse({ data, today, weekLabel, className }: {
  data: CommandOverview | null
  today: TodayStats | null
  weekLabel: string
  className?: string
}) {
  if (!data) return null

  return (
    <div className={className} style={{ display: 'flex', flexWrap: 'wrap', columnGap: 52, rowGap: 20, padding: '0 2px' }}>
      <Metric label={weekLabel} value={String(data.bookings.length)} />
      {today && today.customersAnswered > 0 && (
        <Metric label="Customers answered today" value={String(today.customersAnswered)} />
      )}
      <Metric label="7-day spend" value={`$${data.total_cost_usd.toFixed(2)}`} />
    </div>
  )
}
