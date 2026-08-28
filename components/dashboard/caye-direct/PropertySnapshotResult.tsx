'use client'

import { useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { ExpandResultButton, FullscreenResultOverlay } from './FullscreenResultOverlay'

type Observation = {
  id: string
  structure_id?: string | null
  system_id?: string | null
  asset_id?: string | null
  observation_key: string
  numeric_value?: number | null
  text_value?: string | null
  unit?: string | null
  provenance_status: string
  confidence?: number | null
  observed_at: string
}

type Snapshot = {
  property: { id: string; name: string; property_type: string; location_label?: string | null; status: string }
  structures: Array<{ id: string; name: string; structure_type: string }>
  systems: Array<{ id: string; structure_id?: string | null; name: string; system_type: string; status: string }>
  assets: Array<{ id: string; structure_id?: string | null; system_id?: string | null; name: string; asset_type: string; manufacturer?: string | null; model?: string | null; status: string; specifications?: Record<string, unknown> }>
  current_observations: Observation[]
  observations: Observation[]
}

function valueFor(o: Observation) {
  if (typeof o.numeric_value === 'number') return `${o.numeric_value}${o.unit ? ` ${o.unit}` : ''}`
  return o.text_value ?? '—'
}

function statusDot(status: string) {
  return status === 'needs_attention' || status === 'offline' ? '◉' : status === 'unknown' ? '○' : '●'
}

function PropertyModel({ snapshot, expanded, onExpand }: { snapshot: Snapshot; expanded?: boolean; onExpand?: () => void }) {
  const observations = expanded ? snapshot.current_observations : snapshot.current_observations.slice(0, 12)
  const primaryText = expanded ? '#f4f4f5' : undefined
  const secondaryText = expanded ? '#b8bac2' : '#8e8e96'
  const tertiaryText = expanded ? '#9a9ca5' : '#71717a'
  return (
    <div style={{
      border: '1px solid rgba(255,255,255,.10)',
      background: 'rgba(255,255,255,.025)',
      borderRadius: 14,
      padding: expanded ? 20 : 14,
      display: 'grid',
      gap: expanded ? 18 : 12,
      minHeight: expanded ? '100%' : undefined,
      color: primaryText,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ color: secondaryText, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase' }}>Property model</div>
          <div style={{ fontSize: expanded ? 24 : 17, fontWeight: 650, color: primaryText }}>{snapshot.property.name}</div>
          <div style={{ color: expanded ? '#c5c6cc' : '#a1a1aa', fontSize: expanded ? 12 : 11 }}>{snapshot.property.location_label || snapshot.property.property_type}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 10, color: secondaryText }}>{snapshot.structures.length} structures · {snapshot.systems.length} systems · {snapshot.assets.length} assets</div>
          {!expanded && onExpand ? <ExpandResultButton onClick={onExpand} label={`Open ${snapshot.property.name} full screen`} /> : null}
        </div>
      </div>

      {snapshot.systems.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: expanded ? 'repeat(auto-fit,minmax(260px,1fr))' : 'repeat(auto-fit,minmax(150px,1fr))', gap: expanded ? 12 : 8 }}>
          {snapshot.systems.map((system) => {
            const assets = snapshot.assets.filter((a) => a.system_id === system.id)
            return (
              <div key={system.id} style={{ border: '1px solid rgba(255,255,255,.07)', borderRadius: 10, padding: expanded ? 14 : 10, minHeight: expanded ? 110 : 80 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ fontSize: expanded ? 14 : 12, fontWeight: 600, color: primaryText }}>{system.name}</div>
                  <div title={system.status} style={{ fontSize: 10, color: secondaryText }}>{statusDot(system.status)}</div>
                </div>
                <div style={{ color: secondaryText, fontSize: 10, marginBottom: 7 }}>{system.system_type}</div>
                {assets.length === 0 ? <div style={{ color: tertiaryText, fontSize: 10 }}>No assets recorded</div> : assets.map((asset) => (
                  <div key={asset.id} style={{ fontSize: expanded ? 12 : 10, color: expanded ? '#d7d7dc' : '#c4c4cc', padding: '3px 0' }}>{statusDot(asset.status)} {asset.name} <span style={{ color: tertiaryText }}>· {asset.asset_type}</span></div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {observations.length > 0 && (
        <div>
          <div style={{ color: secondaryText, fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 7 }}>Current known state</div>
          <div style={{ display: 'grid', gridTemplateColumns: expanded ? 'repeat(auto-fit,minmax(220px,1fr))' : 'repeat(auto-fit,minmax(175px,1fr))', gap: expanded ? 8 : 5 }}>
            {observations.map((observation) => (
              <div key={observation.id} style={{ padding: expanded ? '10px 11px' : '7px 8px', background: expanded ? 'rgba(255,255,255,.055)' : 'rgba(255,255,255,.035)', borderRadius: 7 }}>
                <div style={{ color: secondaryText, fontSize: expanded ? 10 : 9 }}>{observation.observation_key} · {observation.provenance_status}</div>
                <div style={{ fontSize: expanded ? 14 : 12, marginTop: expanded ? 3 : 0, color: primaryText, lineHeight: expanded ? 1.45 : undefined }}>{valueFor(observation)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function PropertySnapshotResult({ propertyId, workspaceId }: { propertyId: string; workspaceId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { session } = await getSession()
        if (!session) throw new Error('Founder session unavailable')
        const res = await fetch(`/api/founder/property-snapshots/${encodeURIComponent(propertyId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        if (!res.ok) throw new Error('snapshot unavailable')
        const body = await res.json()
        if (active) setSnapshot(body.snapshot as Snapshot)
      } catch {
        if (active) setError(true)
      }
    })()
    return () => { active = false }
  }, [propertyId, workspaceId])

  if (error) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Property snapshot unavailable.</div>
  if (!snapshot) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Loading property model…</div>

  return (
    <>
      <PropertyModel snapshot={snapshot} onExpand={() => setExpanded(true)} />
      <FullscreenResultOverlay open={expanded} title={snapshot.property.name} onClose={() => setExpanded(false)}>
        <PropertyModel snapshot={snapshot} expanded />
      </FullscreenResultOverlay>
    </>
  )
}
