'use client'

import { useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { ExpandResultButton, FullscreenResultOverlay } from './FullscreenResultOverlay'
import { PropertySpatialScene } from './PropertySpatialScene'

type Observation = { id: string; structure_id?: string | null; system_id?: string | null; asset_id?: string | null; observation_key: string; numeric_value?: number | null; text_value?: string | null; unit?: string | null; provenance_status: string; confidence?: number | null; notes?: string | null }
type Structure = { id: string; name: string; structure_type: string; metadata?: Record<string, unknown> }
type System = { id: string; structure_id?: string | null; name: string; system_type: string; status: string; metadata?: Record<string, unknown> }
type Asset = { id: string; structure_id?: string | null; system_id?: string | null; name: string; asset_type: string; status: string; manufacturer?: string | null; model?: string | null; metadata?: Record<string, unknown> }
type SensorDevice = { id: string; asset_id?: string | null; device_key: string; provider: string; sensor_kind: string; status: string }
type Telemetry = { id: string; device_id: string; metric_key: string; numeric_value: number; unit: string; observed_at: string }
type Snapshot = { property: { id: string; name: string; property_type: string; location_label?: string | null; status: string; metadata?: Record<string, unknown> }; structures: Structure[]; systems: System[]; assets: Asset[]; current_observations: Observation[]; sensor_devices?: SensorDevice[]; current_telemetry?: Telemetry[] }
type Selection = { kind: 'property' | 'structure' | 'system' | 'asset'; id: string }
type ViewMode = 'site' | 'house' | '3d' | 'satellite'

const panel: React.CSSProperties = { border: '1px solid rgba(255,255,255,.09)', background: 'rgba(255,255,255,.025)', borderRadius: 14 }
const muted = '#858790'
const aqua = '#7dd8e0'

function statusColor(status: string) {
  if (status === 'needs_attention' || status === 'offline') return '#f0a565'
  if (status === 'unknown' || status === 'planned') return '#92949c'
  return '#63c8c8'
}
function titleCase(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) }
function valueFor(o: Observation) { return typeof o.numeric_value === 'number' ? `${o.numeric_value}${o.unit ? ` ${o.unit}` : ''}` : o.text_value ?? '—' }
function roomName(asset: Asset) {
  const source = `${typeof asset.metadata?.location === 'string' ? asset.metadata.location : ''} ${typeof asset.metadata?.serves === 'string' ? asset.metadata.serves : ''}`.toLowerCase()
  if (source.includes('center bathroom')) return 'Center Bathroom'
  if (source.includes('right bathroom')) return 'Right Bathroom'
  if (source.includes('main bedroom')) return 'Main Bedroom'
  if (source.includes('bedroom 2')) return 'Bedroom 2'
  if (source.includes('bedroom 3')) return 'Bedroom 3'
  if (source.includes('living') && source.includes('kitchen')) return 'Living / Kitchen'
  if (source.includes('kitchen')) return 'Kitchen'
  if (source.includes('hallway')) return 'Hallway'
  return null
}
function StatusPill({ status }: { status: string }) { return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 7px', borderRadius: 999, border: `1px solid ${statusColor(status)}55`, color: statusColor(status), fontSize: 9.5, background: `${statusColor(status)}12`, textTransform: 'uppercase' }}><span style={{ width: 5, height: 5, borderRadius: 99, background: 'currentColor' }} />{status.replaceAll('_', ' ')}</span> }

function Compact({ snapshot, onExpand }: { snapshot: Snapshot; onExpand: () => void }) {
  const attention = snapshot.assets.filter(a => a.status === 'needs_attention').length
  const sensors = snapshot.sensor_devices?.length ?? 0
  return <div style={{ ...panel, padding: 14, display: 'grid', gap: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}><div><div style={{ color: '#8e8e96', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase' }}>Digital property</div><div style={{ fontSize: 17, fontWeight: 650 }}>{snapshot.property.name}</div><div style={{ color: '#a1a1aa', fontSize: 11 }}>{snapshot.property.location_label || snapshot.property.property_type}</div></div><ExpandResultButton onClick={onExpand} label={`Open ${snapshot.property.name} spatial twin`} /></div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 7 }}>{[['Structures', snapshot.structures.length], ['Systems', snapshot.systems.length], ['Needs attention', attention], ['Sensors', sensors ? `${sensors} planned` : 0]].map(([label, value]) => <div key={String(label)} style={{ padding: '8px 9px', borderRadius: 9, background: 'rgba(255,255,255,.035)' }}><div style={{ fontSize: 9, color: '#71717a' }}>{label}</div><div style={{ fontSize: 13, fontWeight: 650, marginTop: 2 }}>{value}</div></div>)}</div>
  </div>
}

const SITE = [
  { key: 'front house', x: 245, y: 48, w: 175, h: 105, label: 'Front House' },
  { key: 'water tank pad', x: 545, y: 55, w: 160, h: 112, label: 'Water Tank Pad' },
  { key: 'main house', x: 185, y: 205, w: 285, h: 185, label: 'Main House' },
  { key: 'shed', x: 535, y: 235, w: 135, h: 95, label: 'Shed' },
  { key: 'pump house', x: 590, y: 390, w: 115, h: 75, label: 'Pump House' },
]

function SitePlan({ snapshot, selectedId, onSelect }: { snapshot: Snapshot; selectedId?: string; onSelect: (id: string) => void }) {
  return <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,.08)', background: 'linear-gradient(145deg,#111719,#0b0e10)' }}>
    <svg viewBox="0 0 800 520" style={{ display: 'block', width: '100%', minHeight: 360 }} role="img" aria-label="Schematic site plan based on the operator sketch">
      <defs><pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#253033" strokeWidth="1" /></pattern></defs>
      <rect width="800" height="520" fill="url(#grid)" />
      <path d="M470 285 C515 285 515 110 555 110" fill="none" stroke="#3c7277" strokeDasharray="8 8" strokeWidth="2" opacity=".75" />
      <path d="M603 168 C603 200 600 215 600 235" fill="none" stroke="#3c7277" strokeDasharray="8 8" strokeWidth="2" opacity=".75" />
      {SITE.map(node => {
        const structure = snapshot.structures.find(s => s.name.toLowerCase() === node.key)
        if (!structure) return null
        const active = selectedId === structure.id
        const isTank = node.key === 'water tank pad'
        return <g key={node.key} onClick={() => onSelect(structure.id)} style={{ cursor: 'pointer' }}>
          <rect x={node.x} y={node.y} width={node.w} height={node.h} rx="16" fill={active ? '#143136' : '#171d1f'} stroke={active ? '#69d1d3' : '#3a4447'} strokeWidth={active ? 3 : 1.4} />
          {isTank && <><circle cx={node.x + 53} cy={node.y + 56} r="31" fill="#0d1213" stroke="#67767a" strokeWidth="3"/><circle cx={node.x + 108} cy={node.y + 56} r="31" fill="#0d1213" stroke="#67767a" strokeWidth="3"/></>}
          <text x={node.x + 14} y={node.y + node.h - 15} fill={active ? '#a7eef0' : '#d2d5d7'} fontSize="15" fontWeight="600">{node.label}</text>
        </g>
      })}
      <text x="22" y="495" fill="#747b7f" fontSize="12">Schematic from memory/sketch · not north-oriented · not surveyed</text>
    </svg>
  </div>
}

const ROOMS = [
  { name: 'Bedroom 2', x: 35, y: 32, w: 180, h: 125 },
  { name: 'Bedroom 3', x: 225, y: 32, w: 170, h: 125 },
  { name: 'Main Bedroom', x: 405, y: 32, w: 220, h: 125 },
  { name: 'Center Bathroom', x: 230, y: 168, w: 165, h: 110 },
  { name: 'Right Bathroom', x: 475, y: 168, w: 150, h: 110 },
  { name: 'Living / Kitchen', x: 35, y: 290, w: 590, h: 175 },
  { name: 'Hallway', x: 405, y: 168, w: 60, h: 110 },
]
function HousePlan({ snapshot, onSelectAsset, selectedAssetId }: { snapshot: Snapshot; onSelectAsset: (id: string) => void; selectedAssetId?: string }) {
  const main = snapshot.structures.find(s => s.name.toLowerCase().includes('main house'))
  const assets = snapshot.assets.filter(a => a.structure_id === main?.id)
  return <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,.08)', background: '#0e1214' }}>
    <svg viewBox="0 0 660 500" style={{ display: 'block', width: '100%', minHeight: 390 }} role="img" aria-label="Schematic Main House floor plan">
      {ROOMS.map(room => <g key={room.name}><rect x={room.x} y={room.y} width={room.w} height={room.h} rx="7" fill="#151b1d" stroke="#3b4649" strokeWidth="2"/><text x={room.x + 10} y={room.y + 20} fill="#a9afb2" fontSize="12" fontWeight="600">{room.name}</text>{assets.filter(a => roomName(a) === room.name || (room.name === 'Living / Kitchen' && ['Kitchen', 'Living / Kitchen'].includes(roomName(a) ?? ''))).map((asset, index) => { const col = index % 3; const row = Math.floor(index / 3); const x = room.x + 16 + col * 58; const y = room.y + 48 + row * 42; return <g key={asset.id} onClick={() => onSelectAsset(asset.id)} style={{ cursor: 'pointer' }}><circle cx={x} cy={y} r="8" fill={selectedAssetId === asset.id ? aqua : statusColor(asset.status)} /><text x={x + 13} y={y + 4} fill="#c7cbcd" fontSize="8.8">{asset.name.replace(room.name, '').trim() || asset.asset_type}</text></g> })}</g>)}
      <text x="34" y="488" fill="#747b7f" fontSize="11">Room placement follows the memory sketch. Geometry, doors and proportions are approximate.</text>
    </svg>
  </div>
}

function SatellitePanel({ snapshot }: { snapshot: Snapshot }) {
  const geo = snapshot.property.metadata?.geo as { lat?: number; lng?: number } | undefined
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  const ready = typeof geo?.lat === 'number' && typeof geo?.lng === 'number' && Boolean(key)
  const src = ready ? `https://maps.googleapis.com/maps/api/staticmap?center=${geo!.lat},${geo!.lng}&zoom=20&size=900x560&scale=2&maptype=satellite&key=${key}` : ''
  return <div style={{ ...panel, minHeight: 430, overflow: 'hidden', position: 'relative', display: 'grid', placeItems: 'center', background: '#0d1112' }}>
    {ready ? <img src={src} alt={`Satellite view centered on ${snapshot.property.name}`} style={{ width: '100%', height: '100%', minHeight: 430, objectFit: 'cover' }} /> : <div style={{ maxWidth: 520, padding: 32, textAlign: 'center' }}><div style={{ fontSize: 14, fontWeight: 650 }}>Satellite anchor not configured yet</div><div style={{ color: '#858790', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>The twin is ready for real satellite imagery, but this property does not yet have latitude/longitude stored and the dashboard needs a restricted Google Maps browser key. Until those exist, Caye must not guess which roof is yours.</div></div>}
    <div style={{ position: 'absolute', left: 12, bottom: 12, padding: '6px 8px', borderRadius: 8, background: 'rgba(5,8,9,.78)', color: '#b0b4b6', fontSize: 9.5 }}>Satellite imagery is external map data, not a Caye measurement.</div>
  </div>
}

function SpatialTwin({ snapshot }: { snapshot: Snapshot }) {
  const main = snapshot.structures.find(s => s.name.toLowerCase().includes('main house')) ?? snapshot.structures[0]
  const [selection, setSelection] = useState<Selection>(main ? { kind: 'structure', id: main.id } : { kind: 'property', id: snapshot.property.id })
  const [view, setView] = useState<ViewMode>('site')
  const selectedAsset = selection.kind === 'asset' ? snapshot.assets.find(a => a.id === selection.id) : undefined
  const selectedStructure = selection.kind === 'structure' ? snapshot.structures.find(s => s.id === selection.id) : selectedAsset ? snapshot.structures.find(s => s.id === selectedAsset.structure_id) : undefined
  const selectedSystem = selection.kind === 'system' ? snapshot.systems.find(s => s.id === selection.id) : selectedAsset ? snapshot.systems.find(s => s.id === selectedAsset.system_id) : undefined
  const entityName = selection.kind === 'property' ? snapshot.property.name : selection.kind === 'structure' ? selectedStructure?.name : selection.kind === 'system' ? selectedSystem?.name : selectedAsset?.name
  const entityStatus = selection.kind === 'property' ? snapshot.property.status : selection.kind === 'structure' ? 'modeled' : selection.kind === 'system' ? selectedSystem?.status ?? 'unknown' : selectedAsset?.status ?? 'unknown'
  const observations = snapshot.current_observations.filter(o => selection.kind === 'property' ? !o.structure_id && !o.system_id && !o.asset_id : selection.kind === 'structure' ? o.structure_id === selection.id && !o.asset_id && !o.system_id : selection.kind === 'system' ? o.system_id === selection.id && !o.asset_id : o.asset_id === selection.id)
  const water = snapshot.systems.find(s => s.system_type === 'water' && s.name.toLowerCase().includes('water'))
  const waterAssets = water ? snapshot.assets.filter(a => a.system_id === water.id) : []
  const sensors = snapshot.sensor_devices ?? []
  const telemetry = snapshot.current_telemetry ?? []

  return <div style={{ minHeight: '100%', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', gap: 12, color: '#f4f4f5' }}>
    <header style={{ ...panel, padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14 }}><div><div style={{ fontSize: 10, color: '#7f8189', textTransform: 'uppercase', letterSpacing: '.08em' }}>Property Intelligence · spatial twin v0.2</div><div style={{ fontSize: 20, fontWeight: 680 }}>{snapshot.property.name}</div></div><div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{(['site','house','3d','satellite'] as ViewMode[]).map(mode => <button key={mode} type="button" onClick={() => setView(mode)} style={{ padding: '6px 9px', borderRadius: 8, border: view === mode ? '1px solid rgba(125,216,224,.55)' : '1px solid rgba(255,255,255,.08)', background: view === mode ? 'rgba(125,216,224,.08)' : 'transparent', color: view === mode ? aqua : '#9b9da4', cursor: 'pointer', fontSize: 10 }}>{mode === '3d' ? '3D' : titleCase(mode)}</button>)}<StatusPill status={snapshot.property.status}/></div></header>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 12, minHeight: 0 }}>
      <main style={{ minWidth: 0, overflow: 'auto', display: 'grid', alignContent: 'start', gap: 12 }}>
        {view === 'site' && <SitePlan snapshot={snapshot} selectedId={selectedStructure?.id} onSelect={id => setSelection({ kind: 'structure', id })} />}
        {view === 'house' && <HousePlan snapshot={snapshot} selectedAssetId={selectedAsset?.id} onSelectAsset={id => setSelection({ kind: 'asset', id })} />}
        {view === '3d' && <PropertySpatialScene structures={snapshot.structures} selectedStructureId={selectedStructure?.id} onSelectStructure={id => setSelection({ kind: 'structure', id })} />}
        {view === 'satellite' && <SatellitePanel snapshot={snapshot} />}
        {water && <section style={{ ...panel, padding: 12 }}><div style={{ fontSize: 10, color: muted, textTransform: 'uppercase', letterSpacing: '.06em' }}>Water overlay</div><div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 8 }}>{waterAssets.map((asset, index) => <div key={asset.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{index > 0 && <span style={{ color: '#4f8d93' }}>→</span>}<button type="button" onClick={() => setSelection({ kind: 'asset', id: asset.id })} style={{ minWidth: 112, padding: '8px 9px', borderRadius: 9, border: '1px solid rgba(255,255,255,.07)', background: selectedAsset?.id === asset.id ? 'rgba(125,216,224,.08)' : 'rgba(255,255,255,.025)', color: '#d8d9dd', cursor: 'pointer', textAlign: 'left', fontSize: 10.5 }}>{asset.name}<div style={{ color: statusColor(asset.status), fontSize: 9, marginTop: 2 }}>{asset.status.replaceAll('_',' ')}</div></button></div>)}</div><div style={{ color: '#777983', fontSize: 10, marginTop: 8 }}>{typeof water.metadata?.layout === 'string' ? water.metadata.layout : 'roof catchment → tanks → pump → pressure vessel → filtration → house'}</div></section>}
        <section style={{ ...panel, padding: 12 }}><div style={{ fontSize: 10, color: muted, textTransform: 'uppercase', letterSpacing: '.06em' }}>Live reality</div><div style={{ fontSize: 13, fontWeight: 620, marginTop: 2 }}>Sensors & telemetry</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 8, marginTop: 9 }}>{sensors.map(sensor => { const asset = snapshot.assets.find(a => a.id === sensor.asset_id); const values = telemetry.filter(t => t.device_id === sensor.id); return <div key={sensor.id} style={{ padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,.07)' }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 11 }}>{asset?.name ?? sensor.device_key}</strong><StatusPill status={sensor.status}/></div>{values.length ? values.map(v => <div key={v.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 7 }}><span style={{ color: muted }}>{titleCase(v.metric_key)}</span><span>{v.numeric_value} {v.unit}</span></div>) : <div style={{ color: '#6d7078', fontSize: 10, marginTop: 8 }}>No live reading yet.</div>}</div> })}</div></section>
      </main>
      <aside style={{ ...panel, padding: 13, overflow: 'auto' }}><div style={{ color: muted, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.07em' }}>Inspector</div><div style={{ fontSize: 17, fontWeight: 650, marginTop: 3 }}>{entityName ?? snapshot.property.name}</div><div style={{ marginTop: 7 }}><StatusPill status={entityStatus}/></div>{selectedAsset && <div style={{ display: 'grid', gap: 4, marginTop: 14, fontSize: 10.5 }}><Info label="Type" value={selectedAsset.asset_type}/>{selectedStructure && <Info label="Structure" value={selectedStructure.name}/>} {selectedSystem && <Info label="System" value={selectedSystem.name}/>} {selectedAsset.manufacturer && <Info label="Manufacturer" value={selectedAsset.manufacturer}/>}</div>}<div style={{ marginTop: 16, color: muted, fontSize: 9.5, textTransform: 'uppercase' }}>Current known state</div>{observations.length ? observations.slice(0,16).map(o => <div key={o.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.055)' }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 7, fontSize: 9.5 }}><span style={{ color: '#92949c' }}>{titleCase(o.observation_key)}</span><span style={{ color: o.provenance_status === 'operator_confirmed' ? aqua : '#b7a65e' }}>{o.provenance_status}</span></div><div style={{ fontSize: 11.5, lineHeight: 1.45, marginTop: 3 }}>{valueFor(o)}</div>{o.notes && <div style={{ color: '#6d7078', fontSize: 9.5, lineHeight: 1.4, marginTop: 3 }}>{o.notes}</div>}</div>) : <div style={{ color: '#676a72', fontSize: 10.5, marginTop: 8 }}>Select a structure or asset to inspect its recorded state.</div>}</aside>
    </div>
  </div>
}

function Info({ label, value }: { label: string; value: string }) { return <div style={{ display: 'grid', gridTemplateColumns: '85px 1fr', gap: 8 }}><span style={{ color: muted }}>{label}</span><span>{value}</span></div> }

export function PropertySpatialResult({ propertyId, workspaceId }: { propertyId: string; workspaceId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { let active = true; (async () => { try { const { session } = await getSession(); if (!session) throw new Error('Founder session unavailable'); const res = await fetch(`/api/founder/property-snapshots/${encodeURIComponent(propertyId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${session.access_token}` } }); if (!res.ok) throw new Error('snapshot unavailable'); const body = await res.json(); if (active) setSnapshot(body.snapshot as Snapshot) } catch { if (active) setError(true) } })(); return () => { active = false } }, [propertyId, workspaceId])
  if (error) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Property spatial twin unavailable.</div>
  if (!snapshot) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Loading spatial property…</div>
  return <><Compact snapshot={snapshot} onExpand={() => setExpanded(true)}/><FullscreenResultOverlay open={expanded} title={`${snapshot.property.name} · Spatial Digital Twin`} onClose={() => setExpanded(false)}><SpatialTwin snapshot={snapshot}/></FullscreenResultOverlay></>
}
