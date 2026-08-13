'use client'

import type { CommandOverview } from '@/lib/useCommandOverview'
import type { TodayStats } from '@/lib/useTodayStats'

const CARD_BORDER = '#28282d'
const LABEL_COLOR = '#71717a'

// Level 2: real, secondary, small. Deployment status now lives in the
// hero (it's Caye's own state, not a business metric) and "needs review"
// is the AttentionCard itself, not a redundant count — so this strip only
// carries numbers that don't duplicate something already shown elsewhere.
function Metric({ label, value, first }: { label: string; value: string; first?: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 110, padding: '2px 20px', borderLeft: first ? 'none' : `1px solid ${CARD_BORDER}` }}>
      <div style={{
        fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 600,
        color: '#f4f4f5', fontVariantNumeric: 'tabular-nums', marginBottom: 4,
      }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: LABEL_COLOR }}>{label}</div>
    </div>
  )
}

export default function BusinessPulse({ data, today, weekLabel }: {
  data: CommandOverview | null
  today: TodayStats | null
  weekLabel: string
}) {
  if (!data) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
      <Metric first label={weekLabel} value={String(data.bookings.length)} />
      {today && today.customersAnswered > 0 && (
        <Metric label="Customers answered today" value={String(today.customersAnswered)} />
      )}
      <Metric label="7-day spend" value={`$${data.total_cost_usd.toFixed(2)}`} />
    </div>
  )
}
