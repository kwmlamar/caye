'use client'

import { useCallback, useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'
import type { DirectionOutcomeReadModel, MissionOutcome, OutcomeMetric } from '@/lib/direction/outcome-model'
import { AQUA, EMERALD, GOLD, TEXT, TEXT_MUTED, TEXT_QUIET, glass } from '../surface'

function formatMetric(metric: OutcomeMetric) {
  if (metric.value === null) return '—'
  if (metric.unit === 'usd_monthly') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(metric.value)
  return new Intl.NumberFormat('en-US').format(metric.value)
}

function MissionCard({ mission }: { mission: MissionOutcome }) {
  return <article style={{ ...glass(0.04), borderRadius: 14, padding: '16px 17px', minWidth: 0 }}>
    <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: '0.065em', color: mission.key === 'employment' ? AQUA : EMERALD }}>{mission.title}</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginTop: 13 }}>
      {mission.metrics.map((item) => <div key={item.key} title={item.evidence} style={{ padding: '9px 10px', borderRadius: 10, background: 'rgba(255,255,255,0.025)' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: item.value === null ? TEXT_QUIET : TEXT }}>{formatMetric(item)}</div>
        <div style={{ fontSize: 10.5, color: TEXT_MUTED, marginTop: 2 }}>{item.label}</div>
      </div>)}
    </div>
    <div style={{ marginTop: 13, paddingTop: 11, borderTop: '1px solid rgba(255,255,255,0.055)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.055em', color: GOLD }}>PRIMARY BOTTLENECK</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: TEXT, marginTop: 4 }}>{mission.bottleneck?.statement ?? 'Insufficient comparable funnel evidence to identify a bottleneck.'}</div>
      <div style={{ fontSize: 10.5, lineHeight: 1.45, color: TEXT_QUIET, marginTop: 5 }}>{mission.baselineEvidence}</div>
    </div>
  </article>
}

export default function MissionOutcomes() {
  const [data, setData] = useState<DirectionOutcomeReadModel | null>(null)
  const [error, setError] = useState(false)
  const load = useCallback(async () => {
    const { session } = await getSession()
    if (!session) return
    const response = await fetch('/api/founder/direction/outcomes', { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store' })
    if (!response.ok) { setError(true); return }
    setData(await response.json()); setError(false)
  }, [])
  useEffect(() => { void load() }, [load])
  if (error) return <section style={{ marginBottom: 30, fontSize: 11.5, color: TEXT_MUTED }}>Outcome evidence is currently unavailable. Direction is not substituting cached or synthetic success metrics.</section>
  if (!data) return null
  return <section style={{ marginBottom: 30 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 9 }}>
      <div><div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>CURRENT OUTCOMES</div><div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 3 }}>Computed live from canonical job-search, outreach, lifecycle, and commercial state.</div></div>
      <div style={{ fontSize: 10, color: TEXT_QUIET }}>as of {new Date(data.asOf).toLocaleString()}</div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 10 }}><MissionCard mission={data.employment} /><MissionCard mission={data.revenue} /></div>
  </section>
}
