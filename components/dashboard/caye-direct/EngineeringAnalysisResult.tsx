'use client'

import { useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'

type Load = { type: 'force'; region: string; magnitude_n: number; direction: [number, number, number] }
type Constraint = { type: 'fixed'; region: string }
type Analysis = {
  id: string
  sourceArtifactName: string
  sourceArtifactRevision: number
  material: { displayName: string; source: string }
  constraints: Constraint[]
  loads: Load[]
  meshMetadata: { nodeCount: number; elementCount: number; elementType: string }
  results: { max_von_mises_mpa: number; max_displacement_mm: number; factor_of_safety: number | null; disclaimer: string }
}

function describeDirection([x, y, z]: [number, number, number]): string {
  const abs = [Math.abs(x), Math.abs(y), Math.abs(z)]
  const axis = abs.indexOf(Math.max(...abs))
  if (axis === 2) return z < 0 ? 'downward' : 'upward'
  if (axis === 1) return y < 0 ? 'toward the wall' : 'away from the wall'
  return x < 0 ? 'in -X' : 'in +X'
}
function regionLabel(region: string): string {
  return region.replace(/_/g, ' ')
}

/** Trusted result: only an analysis id crosses the chat boundary; this component obtains normalized numeric data via a server-side, founder-gated route. Numeric card only — mirrors EngineeringArtifactResult.tsx's styling; 3D stress-field rendering is a follow-up. */
export function EngineeringAnalysisResult({ analysisId, workspaceId }: { analysisId: string; workspaceId: string }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch(`/api/founder/engineering-analyses/${analysisId}?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await res.json()
      if (!cancelled) { if (res.ok) setAnalysis(json.analysis); else setError(true) }
    })()
    return () => { cancelled = true }
  }, [analysisId, workspaceId])

  if (error) return <div style={{ color: '#a1a1aa', fontSize: 12 }}>Structural analysis is unavailable.</div>
  if (!analysis) return <div style={{ color: '#a1a1aa', fontSize: 12 }}>Loading structural analysis…</div>

  const load = analysis.loads[0]
  const constraint = analysis.constraints[0]

  return (
    <section style={{ marginTop: 12, border: '1px solid rgba(78,190,206,.32)', borderRadius: 12, overflow: 'hidden', background: 'rgba(78,190,206,.05)', minWidth: 300 }}>
      <div style={{ padding: '10px 12px', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>STATIC STRUCTURAL ANALYSIS</span>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: '#72cfd9' }}>REV {analysis.sourceArtifactRevision}</span>
      </div>
      <div style={{ padding: '0 12px 10px', fontSize: 11, color: '#b8b8bf' }}>
        <div>Artifact: {analysis.sourceArtifactName}</div>
        <div>Material: {analysis.material.displayName}</div>
        {load && <div>Load: {load.magnitude_n.toFixed(0)} N {describeDirection(load.direction)} on {regionLabel(load.region)}</div>}
        {constraint && <div>Constraint: {regionLabel(constraint.region)} fixed</div>}
        {analysis.loads.length > 1 && <div>+ {analysis.loads.length - 1} more load(s)</div>}
        {analysis.constraints.length > 1 && <div>+ {analysis.constraints.length - 1} more constraint(s)</div>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'rgba(255,255,255,.08)' }}>
        <div style={{ padding: '10px 12px', background: '#101315' }}>
          <div style={{ color: '#8e8e96', fontSize: 10 }}>Max von Mises stress</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{analysis.results.max_von_mises_mpa.toFixed(1)} MPa</div>
        </div>
        <div style={{ padding: '10px 12px', background: '#101315' }}>
          <div style={{ color: '#8e8e96', fontSize: 10 }}>Max displacement</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{analysis.results.max_displacement_mm.toFixed(3)} mm</div>
        </div>
        <div style={{ padding: '10px 12px', background: '#101315' }}>
          <div style={{ color: '#8e8e96', fontSize: 10 }}>Factor of safety</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{analysis.results.factor_of_safety != null ? analysis.results.factor_of_safety.toFixed(2) : 'Not available'}</div>
          {analysis.results.factor_of_safety == null && <div style={{ color: '#8e8e96', fontSize: 9.5 }}>Yield strength unknown for this material</div>}
        </div>
        <div style={{ padding: '10px 12px', background: '#101315' }}>
          <div style={{ color: '#8e8e96', fontSize: 10 }}>Mesh</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{analysis.meshMetadata.nodeCount.toLocaleString()} nodes / {analysis.meshMetadata.elementCount.toLocaleString()} elements</div>
        </div>
      </div>
      <p style={{ margin: '10px 12px 11px', fontSize: 10, color: '#8e8e96', lineHeight: 1.4 }}>{analysis.results.disclaimer}</p>
    </section>
  )
}
