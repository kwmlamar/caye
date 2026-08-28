'use client'

import { useEffect, useState } from 'react'

type Snapshot = {
  property: { id: string; name: string; property_type: string; location_label?: string | null; status: string }
  structures: Array<{ id: string; name: string; structure_type: string }>
  systems: Array<{ id: string; structure_id?: string | null; name: string; system_type: string; status: string }>
  assets: Array<{ id: string; structure_id?: string | null; system_id?: string | null; name: string; asset_type: string; manufacturer?: string | null; model?: string | null; status: string; specifications?: Record<string, unknown> }>
  observations: Array<{ id: string; structure_id?: string | null; system_id?: string | null; asset_id?: string | null; observation_key: string; numeric_value?: number | null; text_value?: string | null; unit?: string | null; provenance_status: string; confidence?: number | null; observed_at: string }>
}

function valueFor(o: Snapshot['observations'][number]) {
  if (typeof o.numeric_value === 'number') return `${o.numeric_value}${o.unit ? ` ${o.unit}` : ''}`
  return o.text_value ?? '—'
}

function statusDot(status: string) {
  return status === 'needs_attention' || status === 'offline' ? '◉' : status === 'unknown' ? '○' : '●'
}

export function PropertySnapshotResult({ propertyId, workspaceId }: { propertyId: string; workspaceId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    fetch(`/api/founder/property-snapshots/${encodeURIComponent(propertyId)}?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error('snapshot unavailable')
        return r.json()
      })
      .then((body) => { if (active) setSnapshot(body.snapshot as Snapshot) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [propertyId, workspaceId])

  if (error) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Property snapshot unavailable.</div>
  if (!snapshot) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Loading property model…</div>

  const latestByKey = new Map<string, Snapshot['observations'][number]>()
  for (const observation of snapshot.observations) {
    const key = `${observation.asset_id ?? observation.system_id ?? observation.structure_id ?? 'property'}:${observation.observation_key}`
    if (!latestByKey.has(key)) latestByKey.set(key, observation)
  }
  const latest = [...latestByKey.values()].slice(0, 12)

  return (
    <div style={{ border: '1px solid rgba(255,255,255,.10)', background: 'rgba(255,255,255,.025)', borderRadius: 14, padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ color: '#8e8e96', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase' }}>Property model</div>
          <div style={{ fontSize: 17, fontWeight: 650 }}>{snapshot.property.name}</div>
          <div style={{ color: '#a1a1aa', fontSize: 11 }}>{snapshot.property.location_label || snapshot.property.property_type}</div>
        </div>
        <div style={{ fontSize: 10, color: '#8e8e96' }}>{snapshot.structures.length} structures · {snapshot.systems.length} systems · {snapshot.assets.length} assets</div>
      </div>

      {snapshot.systems.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8 }}>
          {snapshot.systems.map((system) => {
            const assets = snapshot.assets.filter((a) => a.system_id === system.id)
            return (
              <div key={system.id} style={{ border: '1px solid rgba(255,255,255,.07)', borderRadius: 10, padding: 10, minHeight: 80 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{system.name}</div>
                  <div title={system.status} style={{ fontSize: 10, color: '#8e8e96' }}>{statusDot(system.status)}</div>
                </div>
                <div style={{ color: '#8e8e96', fontSize: 10, marginBottom: 7 }}>{system.system_type}</div>
                {assets.length === 0 ? <div style={{ color: '#71717a', fontSize: 10 }}>No assets recorded</div> : assets.slice(0, 5).map((asset) => (
                  <div key={asset.id} style={{ fontSize: 10, color: '#c4c4cc', padding: '2px 0' }}>{statusDot(asset.status)} {asset.name} <span style={{ color: '#71717a' }}>· {asset.asset_type}</span></div>
                ))}
                {assets.length > 5 && <div style={{ fontSize: 10, color: '#71717a' }}>+{assets.length - 5} more</div>}
              </div>
            )
          })}
        </div>
      )}

      {latest.length > 0 && (
        <div>
          <div style={{ color: '#8e8e96', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 5 }}>Latest known state</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(175px,1fr))', gap: 5 }}>
            {latest.map((observation) => (
              <div key={observation.id} style={{ padding: '7px 8px', background: 'rgba(255,255,255,.035)', borderRadius: 7 }}>
                <div style={{ color: '#8e8e96', fontSize: 9 }}>{observation.observation_key} · {observation.provenance_status}</div>
                <div style={{ fontSize: 12 }}>{valueFor(observation)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
