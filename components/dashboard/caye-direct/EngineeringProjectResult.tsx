'use client'

import { useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'

type Snapshot = {
  project: { id: string; name: string; objective: string; problem_statement?: string | null; status: string; priority: string; success_criteria: string[] }
  baselines: Array<{ id: string; revision: number; status: string; frozen_at?: string | null }>
  alternatives: Array<{ id: string; alternative_key: string; revision: number; title: string; description: string; status: string; estimated_cost?: number | null; cost_currency?: string | null }>
  predictions: Array<{ id: string; alternative_id: string; metric_key: string; numeric_value: number; unit: string; provenance_status: string }>
  decisions: Array<{ id: string; alternative_id: string; selected_at: string; superseded_at?: string | null }>
  execution_evidence: Array<{ id: string; evidence_type: string; notes?: string | null; occurred_at: string }>
  outcomes: Array<{ id: string; metric_key: string; property_observation_id: string }>
  verdicts: Array<{ id: string; verdict: string; summary: string; reason_codes: string[]; superseded_at?: string | null }>
  comparison: { comparisons: Array<{ metricKey: string; unit: string; predicted: number; actual: number; delta: number; percentError: number | null; direction: string }>; missingActual: string[]; incompatible: Array<{ metricKey: string; reason: string }>; note?: string }
}

function badge(value: string) {
  return <span style={{ border: '1px solid rgba(255,255,255,.10)', borderRadius: 999, padding: '3px 7px', color: '#a1a1aa', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em' }}>{value.replaceAll('_',' ')}</span>
}

export function EngineeringProjectResult({ projectId }: { projectId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { session } = await getSession()
        if (!session) throw new Error('Founder session unavailable')
        const res = await fetch(`/api/founder/engineering-projects/${encodeURIComponent(projectId)}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
        if (!res.ok) throw new Error('Project unavailable')
        const body = await res.json()
        if (active) setSnapshot(body.snapshot as Snapshot)
      } catch { if (active) setError(true) }
    })()
    return () => { active = false }
  }, [projectId])

  const selectedAlternativeId = useMemo(() => snapshot?.decisions.find((d) => !d.superseded_at)?.alternative_id ?? null, [snapshot])
  if (error) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Engineering project snapshot unavailable.</div>
  if (!snapshot) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Loading engineering project…</div>

  const activeVerdict = snapshot.verdicts.find((v) => !v.superseded_at)
  return <section style={{ border: '1px solid rgba(78,190,206,.24)', background: 'rgba(78,190,206,.035)', borderRadius: 14, padding: 14, display: 'grid', gap: 13 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
      <div><div style={{ color: '#72cfd9', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase' }}>Engineering project</div><div style={{ fontSize: 17, fontWeight: 650 }}>{snapshot.project.name}</div><div style={{ color: '#b8b8bf', fontSize: 11, marginTop: 3 }}>{snapshot.project.objective}</div></div>
      <div style={{ display: 'flex', gap: 5 }}>{badge(snapshot.project.status)}{badge(snapshot.project.priority)}</div>
    </div>

    {snapshot.project.success_criteria?.length > 0 && <div><div style={{ color: '#8e8e96', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>Success criteria</div>{snapshot.project.success_criteria.map((c, i) => <div key={i} style={{ fontSize: 11, padding: '2px 0' }}>• {c}</div>)}</div>}

    <div style={{ display: 'grid', gap: 7 }}>
      <div style={{ color: '#8e8e96', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em' }}>Alternatives</div>
      {snapshot.alternatives.length === 0 ? <div style={{ color: '#71717a', fontSize: 11 }}>No interventions recorded yet.</div> : snapshot.alternatives.map((a) => {
        const preds = snapshot.predictions.filter((p) => p.alternative_id === a.id)
        return <div key={a.id} style={{ border: a.id === selectedAlternativeId ? '1px solid rgba(78,190,206,.45)' : '1px solid rgba(255,255,255,.07)', borderRadius: 10, padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 12 }}>{a.title}</strong><span style={{ fontSize: 9, color: '#8e8e96' }}>REV {a.revision} · {a.id === selectedAlternativeId ? 'SELECTED' : a.status.toUpperCase()}</span></div>
          <div style={{ color: '#a1a1aa', fontSize: 10, marginTop: 3 }}>{a.description}</div>
          {a.estimated_cost != null && <div style={{ fontSize: 10, marginTop: 5 }}>Estimated cost: {a.estimated_cost} {a.cost_currency ?? ''}</div>}
          {preds.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>{preds.map((p) => <span key={p.id} style={{ fontSize: 9, padding: '4px 6px', borderRadius: 6, background: 'rgba(255,255,255,.04)' }}>{p.metric_key}: {p.numeric_value} {p.unit} · {p.provenance_status}</span>)}</div>}
        </div>
      })}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 7 }}>
      <div style={{ padding: 9, borderRadius: 9, background: 'rgba(255,255,255,.035)' }}><div style={{ fontSize: 9, color: '#8e8e96' }}>BASELINE</div><div style={{ fontSize: 12 }}>{snapshot.baselines.length ? `Frozen · rev ${snapshot.baselines[0].revision}` : 'Not established'}</div></div>
      <div style={{ padding: 9, borderRadius: 9, background: 'rgba(255,255,255,.035)' }}><div style={{ fontSize: 9, color: '#8e8e96' }}>EXECUTION EVIDENCE</div><div style={{ fontSize: 12 }}>{snapshot.execution_evidence.length} record{snapshot.execution_evidence.length === 1 ? '' : 's'}</div></div>
      <div style={{ padding: 9, borderRadius: 9, background: 'rgba(255,255,255,.035)' }}><div style={{ fontSize: 9, color: '#8e8e96' }}>OUTCOMES</div><div style={{ fontSize: 12 }}>{snapshot.outcomes.length} linked metric{snapshot.outcomes.length === 1 ? '' : 's'}</div></div>
    </div>

    {(snapshot.comparison.comparisons.length > 0 || snapshot.comparison.missingActual.length > 0 || snapshot.comparison.incompatible.length > 0) && <div>
      <div style={{ color: '#8e8e96', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>Predicted vs actual</div>
      {snapshot.comparison.comparisons.map((c) => <div key={c.metricKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 10, borderTop: '1px solid rgba(255,255,255,.05)', padding: '5px 0' }}><span>{c.metricKey}</span><span>{c.predicted} → {c.actual} {c.unit} ({c.delta >= 0 ? '+' : ''}{c.delta})</span></div>)}
      {snapshot.comparison.missingActual.length > 0 && <div style={{ color: '#a1a1aa', fontSize: 10 }}>Missing actual: {snapshot.comparison.missingActual.join(', ')}</div>}
      {snapshot.comparison.incompatible.map((x) => <div key={x.metricKey} style={{ color: '#a1a1aa', fontSize: 10 }}>{x.metricKey}: {x.reason}</div>)}
    </div>}

    {activeVerdict && <div style={{ borderLeft: '2px solid #4EBECE', paddingLeft: 9 }}><div style={{ fontSize: 9, color: '#72cfd9', textTransform: 'uppercase' }}>Verdict · {activeVerdict.verdict.replaceAll('_',' ')}</div><div style={{ fontSize: 11, marginTop: 3 }}>{activeVerdict.summary}</div></div>}
    <div style={{ color: '#71717a', fontSize: 9, lineHeight: 1.4 }}>Project state is evidence and planning context only. A selected intervention is not authorization, code compliance, potability verification, or structural/electrical safety approval.</div>
  </section>
}
