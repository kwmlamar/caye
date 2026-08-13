'use client'

import { TEXT, TEXT_QUIET, GOLD } from '../../surface'
import type { MemoryData } from './types'

// Same editorial-strip pattern as Home's BusinessPulse — real counts,
// generous spacing, no metric cards.
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

export default function MemoryOverview({ data }: { data: MemoryData }) {
  const learnedCount = data.facts.filter((f) => f.source === 'candidate-confirmed').length
  const clarifyCount = data.candidates.length

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 52, rowGap: 16, padding: '0 2px' }}>
      <Metric value={String(data.facts.length)} label="Things Caye knows" />
      <Metric value={String(data.rules.length)} label="Standing rules" />
      <Metric value={String(learnedCount)} label="Learned from conversations" />
      {clarifyCount > 0 && (
        <Metric value={String(clarifyCount)} label={clarifyCount === 1 ? 'Awaiting your answer' : 'Awaiting your answers'} tone="gold" />
      )}
    </div>
  )
}
