'use client'

import { useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'

type Prediction = { id: string; alternative_id: string; metric_key: string; numeric_value: number; unit: string; provenance_status: string }
type Snapshot = {
  project: { id: string; name: string; objective: string; problem_statement?: string | null; status: string; priority: string; success_criteria: string[] }
  baselines: Array<{ id: string; revision: number; status: string; frozen_at?: string | null }>
  alternatives: Array<{ id: string; alternative_key: string; revision: number; title: string; description: string; status: string; estimated_cost?: number | null; cost_currency?: string | null }>
  predictions: Prediction[]
  decisions: Array<{ id: string; alternative_id: string; selected_at: string; superseded_at?: string | null }>
  execution_evidence: Array<{ id: string; evidence_type: string; notes?: string | null; occurred_at: string }>
  outcomes: Array<{ id: string; metric_key: string; property_observation_id: string }>
  verdicts: Array<{ id: string; verdict: string; summary: string; reason_codes: string[]; superseded_at?: string | null }>
  comparison: { comparisons: Array<{ metricKey: string; unit: string; predicted: number; actual: number; delta: number; percentError: number | null; direction: string }>; missingActual: string[]; incompatible: Array<{ metricKey: string; reason: string }>; note?: string }
}

function badge(value: string) {
  return <span style={{ border: '1px solid rgba(255,255,255,.10)', borderRadius: 999, padding: '3px 7px', color: '#a1a1aa', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em' }}>{value.replaceAll('_',' ')}</span>
}

function metricLabel(key: string) {
  return key.replaceAll('_', ' ')
}

function formatPrediction(prediction?: Prediction) {
  if (!prediction) return '—'
  const value = Number.isInteger(prediction.numeric_value) ? prediction.numeric_value.toString() : prediction.numeric_value.toFixed(1)
  return `${value} ${prediction.unit}`
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
  const metricKeys = useMemo(() => snapshot ? Array.from(new Set(snapshot.predictions.map((p) => p.metric_key))) : [], [snapshot])
  if (error) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Engineering project snapshot unavailable.</div>
  if (!snapshot) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Loading engineering project…</div>

  const activeVerdict = snapshot.verdicts.find((v) => !v.superseded_at)
  return <section style={{ border: '1px solid rgba(78,190,206,.24)', background: 'rgba(78,190,206,.035)', borderRadius: 14, padding: 14, display: 'grid', gap: 13 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
      <div><div style={{ color: '#72cfd9', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase' }}>Engineering project</div><div style={{ fontSize: 17, fontWeight: 650 }}>{snapshot.project.name}</div><div style={{ color: '#b8b8bf', fontSize: 11, marginTop: 3 }}>{snapshot.project.objective}</div></div>
      <div style={{ display: 'flex', gap: 5 }}>{badge(snapshot.project.status)}{badge(snapshot.project.priority)}</div>
    </div>

    {snapshot.project.success_criteria?.length > 0 && <div><div style={{ color: '#8e8e96', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>Success criteria</div>{snapshot.project.success_criteria.map((c, i) => <div key={i} style={{ fontSize: 11, padding: '2px 0' }}>• {c}</div>)}</div>}

    {snapshot.alternatives.length > 1 && metricKeys.length > 0 && <div style={{ overflowX: 'auto', border: '1px solid rgba(255,255,255,.07)', borderRadius: 10 }}>
      <div style={{ padding: '9px 10px', color: '#8e8e96', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: '1px solid rgba(255,255,255,.06)' }}>Alternative comparison</div>
      <table style={{ width: '100%', minWidth: 620, borderCollapse: 'collapse', fontSize: 10 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: 9, color: '#8e8e96', fontWeight: 500 }}>Metric</th>
            {snapshot.alternatives.map((a) => <th key={a.id} style={{ textAlign: 'left', padding: 9, color: a.id === selectedAlternativeId ? '#72cfd9' : '#d4d4d8', fontWeight: 600 }}>{a.title}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderTop: '1px solid rgba(255,255,255,.05)' }}><td style={{ padding: 9, color: '#8e8e96' }}>estimated cost</td>{snapshot.alternatives.map((a) => <td key={a.id} style={{ padding: 9 }}>{a.estimated_cost != null ? `${a.estimated_cost} ${a.cost_currency ?? ''}` : 'Needs quote'}</td>)}</tr>
          {metricKeys.map((key) => <tr key={key} style={{ borderTop: '1px solid rgba(255,255,255,.05)' }}>
            <td style={{ padding: 9, color: '#8e8e96' }}>{metricLabel(key)}</td>
            {snapshot.alternatives.map((a) => {
              const prediction = snapshot.predictions.find((p) => p.alternative_id === a.id && p.metric_key === key)
              return <td key={a.id} style={{ padding: 9 }}><div>{formatPrediction(prediction)}</div>{prediction && <div style={{ color: '#71717a', fontSize: 8, marginTop: 2 }}>{prediction.provenance_status.replaceAll('_', ' ')}</div>}</td>
            })}
          </tr>)}
        </tbody>
      </table>
      <div style={{ padding: '8px 10px', color: '#71717a', fontSize: 9, borderTop: '1px solid rgba(255,255,255,.06)' }}>Predictions are planning estimates, not measured outcomes. Missing values stay blank rather than being invented for visual symmetry.</div>
    </div>}

    <div style={{ display: 'grid', gap: 7 }}>
      <div style={{ color: '#8e8e96', fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em' }}>Alternatives</div>
      {snapshot.alternatives.length === 0 ? <div style={{ color: '#71717a', fontSize: 11 }}>No interventions recorded yet.</div> : snapshot.alternatives.map((a) => {
        const preds = snapshot.predictions.filter((p) => p.alternative_id === a.id)
        return <div key={a.id} style={{ border: a.id === selectedAlternativeId ? '1px solid rgba(78,190,206,.45)' : '1px solid rgba(255,255,255,.07)', borderRadius: 10, padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 12 }}>{a.title}</strong><span style={{ fontSize: 9, color: '#8e8e96' }}>REV {a.revision} · {a.id === selectedAlternativeId ? 'SELECTED' : a.status.toUpperCase()}</span></div>
          <div style={{ color: '#a1a1aa', fontSize: 10, marginTop: 3 }}>{a.description}</div>
          {a.estimated_cost != null ? <div style={{ fontSize: 10, marginTop: 5 }}>Estimated cost: {a.estimated_cost} {a.cost_currency ?? ''}</div> : <div style={{ fontSize: 10, marginTop: 5, color: '#8e8e96' }}>Cost: needs quote</div>}
          {preds.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>{preds.map((p) => <span key={p.id} style={{ fontSize: 9, padding: '4px 6px', borderRadius: 6, background: 'rgba(255,255,255,.04)' }}>{metricLabel(p.metric_key)}: {formatPrediction(p)} · {p.provenance_status}</span>)}</div>}
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
