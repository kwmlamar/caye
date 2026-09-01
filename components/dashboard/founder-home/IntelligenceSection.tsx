'use client'

import { useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'
import MissionOutcomes from './MissionOutcomes'
import { AQUA, GOLD, ROSE, TEXT, TEXT_MUTED, TEXT_QUIET, glass } from '../surface'

type IntelligenceItem = {
  id: string
  scope: 'operator' | 'global'
  domain: string
  topic: string
  canonical_claim: string
  epistemic_type: string
  status: string
  confidence: number | string | null
  materiality: number | string | null
  observed_at: string | null
  updated_at: string | null
  relationCount: number
  contradictionCount: number
  revisionCount: number
  latestRevision: { prior_confidence: number | string | null; revised_confidence: number | string; rationale: string; created_at: string } | null
}

function percent(value: number | string | null): string | null {
  if (value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : null
}

export default function IntelligenceSection() {
  const [items, setItems] = useState<IntelligenceItem[]>([])
  const [total, setTotal] = useState(0)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { session } = await getSession()
      if (!session) return
      const response = await fetch('/api/founder/intelligence', { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (!response.ok) return
      const payload = await response.json()
      if (cancelled) return
      setItems(Array.isArray(payload.items) ? payload.items : [])
      setTotal(Number(payload.total ?? 0))
    })()
    return () => { cancelled = true }
  }, [])

  const visible = useMemo(() => expanded ? items : items.slice(0, 5), [expanded, items])

  return <>
    <MissionOutcomes />
    {items.length > 0 && <section style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div><div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>WHAT CAYE CURRENTLY BELIEVES</div><div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 4 }}>Durable intelligence, including contested beliefs and confidence changes.</div></div>
        <div style={{ fontSize: 10.5, color: TEXT_QUIET }}>{total} current</div>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {visible.map((item) => {
          const confidence = percent(item.confidence)
          const revised = item.latestRevision ? percent(item.latestRevision.revised_confidence) : null
          const prior = item.latestRevision ? percent(item.latestRevision.prior_confidence) : null
          return <div key={item.id} style={{ ...glass(0.035), borderRadius: 12, padding: '11px 13px' }}><div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', marginTop: 5, flexShrink: 0, background: item.contradictionCount > 0 ? ROSE : item.revisionCount > 0 ? GOLD : AQUA }} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12.5, lineHeight: 1.45, color: TEXT }}>{item.canonical_claim}</div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 5, fontSize: 10.5, color: TEXT_QUIET }}><span>{item.domain}</span><span>{item.epistemic_type.replaceAll('_', ' ')}</span>{confidence && <span>{confidence} confidence</span>}{item.relationCount > 0 && <span>{item.relationCount} relation{item.relationCount === 1 ? '' : 's'}</span>}{item.contradictionCount > 0 && <span style={{ color: ROSE }}>{item.contradictionCount} contradiction{item.contradictionCount === 1 ? '' : 's'}</span>}</div>{item.latestRevision && <div style={{ marginTop: 6, fontSize: 10.5, color: TEXT_MUTED, lineHeight: 1.45 }}><span style={{ color: GOLD }}>Belief revised{prior && revised ? ` ${prior} → ${revised}` : ''} · </span>{item.latestRevision.rationale}</div>}</div>
          </div></div>
        })}
      </div>
      {items.length > 5 && <button type="button" onClick={() => setExpanded((value) => !value)} style={{ marginTop: 9, border: 0, background: 'transparent', padding: 0, cursor: 'pointer', color: AQUA, font: '600 11px inherit' }}>{expanded ? 'Show recent 5' : `View all ${items.length}`}</button>}
    </section>}
  </>
}
