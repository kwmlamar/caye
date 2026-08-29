'use client'

import { useEffect, useMemo, useState } from 'react'
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
  notes?: string | null
}

type Structure = {
  id: string
  name: string
  structure_type: string
  metadata?: Record<string, unknown>
}

type System = {
  id: string
  structure_id?: string | null
  name: string
  system_type: string
  status: string
  metadata?: Record<string, unknown>
}

type Asset = {
  id: string
  structure_id?: string | null
  system_id?: string | null
  name: string
  asset_type: string
  manufacturer?: string | null
  model?: string | null
  status: string
  specifications?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

type SensorDevice = {
  id: string
  system_id?: string | null
  asset_id?: string | null
  device_key: string
  provider: string
  provider_application_id?: string | null
  provider_device_id?: string | null
  sensor_kind: string
  status: string
  calibration?: Record<string, unknown>
  metadata?: Record<string, unknown>
  installed_at?: string | null
  last_seen_at?: string | null
}

type Telemetry = {
  id: string
  device_id: string
  metric_key: string
  numeric_value: number
  unit: string
  observed_at: string
  quality: string
  calibration_version?: string | null
  device_key: string
  sensor_kind: string
  device_status: string
  last_seen_at?: string | null
}

type Snapshot = {
  property: {
    id: string
    name: string
    property_type: string
    location_label?: string | null
    status: string
    metadata?: Record<string, unknown>
  }
  structures: Structure[]
  systems: System[]
  assets: Asset[]
  current_observations: Observation[]
  observations: Observation[]
  sensor_devices?: SensorDevice[]
  current_telemetry?: Telemetry[]
}

type Selection =
  | { kind: 'property'; id: string }
  | { kind: 'structure'; id: string }
  | { kind: 'system'; id: string }
  | { kind: 'asset'; id: string }

type RoomGroup = { name: string; assets: Asset[] }

const panel: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,.09)',
  background: 'rgba(255,255,255,.025)',
  borderRadius: 14,
}

function valueFor(o: Observation) {
  if (typeof o.numeric_value === 'number') return `${o.numeric_value}${o.unit ? ` ${o.unit}` : ''}`
  return o.text_value ?? '—'
}

function statusColor(status: string) {
  if (status === 'needs_attention' || status === 'offline') return '#f0a565'
  if (status === 'unknown' || status === 'planned') return '#8b8d96'
  if (status === 'stale') return '#d7b65d'
  return '#63c8c8'
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function roomName(asset: Asset): string | null {
  const location = typeof asset.metadata?.location === 'string' ? asset.metadata.location.toLowerCase() : ''
  const serves = typeof asset.metadata?.serves === 'string' ? asset.metadata.serves.toLowerCase() : ''
  const source = `${location} ${serves}`
  if (source.includes('center bathroom')) return 'Center Bathroom'
  if (source.includes('right bathroom')) return 'Right Bathroom'
  if (source.includes('main bedroom')) return 'Main Bedroom'
  if (source.includes('bedroom 2')) return 'Bedroom 2'
  if (source.includes('bedroom 3')) return 'Bedroom 3'
  if (source.includes('living') && source.includes('kitchen')) return 'Living / Kitchen'
  if (source.includes('living room')) return 'Living Room'
  if (source.includes('kitchen')) return 'Kitchen'
  if (source.includes('hallway')) return 'Hallway'
  if (location) return titleCase(location.split(';')[0].trim())
  return null
}

function entityObservations(snapshot: Snapshot, selection: Selection) {
  return snapshot.current_observations.filter((observation) => {
    if (selection.kind === 'property') return !observation.structure_id && !observation.system_id && !observation.asset_id
    if (selection.kind === 'structure') return observation.structure_id === selection.id && !observation.asset_id && !observation.system_id
    if (selection.kind === 'system') return observation.system_id === selection.id && !observation.asset_id
    return observation.asset_id === selection.id
  })
}

function metadataRows(metadata?: Record<string, unknown>) {
  if (!metadata) return []
  return Object.entries(metadata).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 10)
}

function StatusPill({ status }: { status: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 7px', borderRadius: 999,
      border: `1px solid ${statusColor(status)}55`, color: statusColor(status), fontSize: 9.5,
      background: `${statusColor(status)}12`, textTransform: 'uppercase', letterSpacing: '.04em',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: 'currentColor' }} />
      {status.replaceAll('_', ' ')}
    </span>
  )
}

function CompactPropertyModel({ snapshot, onExpand }: { snapshot: Snapshot; onExpand: () => void }) {
  const attention = snapshot.assets.filter((asset) => asset.status === 'needs_attention').length
  const plannedSensors = snapshot.sensor_devices?.filter((device) => device.status === 'planned').length ?? 0
  return (
    <div style={{ ...panel, padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ color: '#8e8e96', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase' }}>Digital property</div>
          <div style={{ fontSize: 17, fontWeight: 650 }}>{snapshot.property.name}</div>
          <div style={{ color: '#a1a1aa', fontSize: 11 }}>{snapshot.property.location_label || snapshot.property.property_type}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 10, color: '#8e8e96' }}>{snapshot.structures.length} structures · {snapshot.systems.length} systems · {snapshot.assets.length} assets</div>
          <ExpandResultButton onClick={onExpand} label={`Open ${snapshot.property.name} digital twin`} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 7 }}>
        {[
          ['Structures', snapshot.structures.length],
          ['Systems', snapshot.systems.length],
          ['Needs attention', attention],
          ['Sensors', plannedSensors ? `${plannedSensors} planned` : snapshot.sensor_devices?.length ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} style={{ padding: '8px 9px', borderRadius: 9, background: 'rgba(255,255,255,.035)' }}>
            <div style={{ fontSize: 9, color: '#71717a' }}>{label}</div>
            <div style={{ fontSize: 13, fontWeight: 650, marginTop: 2 }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {snapshot.structures.map((structure) => (
          <span key={structure.id} style={{ padding: '5px 7px', borderRadius: 8, border: '1px solid rgba(255,255,255,.07)', color: '#c8c9ce', fontSize: 10 }}>{structure.name}</span>
        ))}
      </div>
    </div>
  )
}

function DigitalTwin({ snapshot }: { snapshot: Snapshot }) {
  const defaultStructure = snapshot.structures.find((s) => s.name.toLowerCase().includes('main house')) ?? snapshot.structures[0]
  const [selection, setSelection] = useState<Selection>(defaultStructure ? { kind: 'structure', id: defaultStructure.id } : { kind: 'property', id: snapshot.property.id })

  useEffect(() => {
    setSelection(defaultStructure ? { kind: 'structure', id: defaultStructure.id } : { kind: 'property', id: snapshot.property.id })
  }, [snapshot.property.id, defaultStructure?.id])

  const selectedStructure = selection.kind === 'structure' ? snapshot.structures.find((s) => s.id === selection.id) : selection.kind === 'asset' ? snapshot.structures.find((s) => s.id === snapshot.assets.find((a) => a.id === selection.id)?.structure_id) : selection.kind === 'system' ? snapshot.structures.find((s) => s.id === snapshot.systems.find((system) => system.id === selection.id)?.structure_id) : undefined
  const selectedSystem = selection.kind === 'system' ? snapshot.systems.find((s) => s.id === selection.id) : selection.kind === 'asset' ? snapshot.systems.find((s) => s.id === snapshot.assets.find((a) => a.id === selection.id)?.system_id) : undefined
  const selectedAsset = selection.kind === 'asset' ? snapshot.assets.find((a) => a.id === selection.id) : undefined

  const structureAssets = selectedStructure ? snapshot.assets.filter((asset) => asset.structure_id === selectedStructure.id) : []
  const roomGroups = useMemo(() => {
    const map = new Map<string, Asset[]>()
    for (const asset of structureAssets) {
      const room = roomName(asset)
      if (!room) continue
      map.set(room, [...(map.get(room) ?? []), asset])
    }
    return [...map.entries()].map(([name, assets]) => ({ name, assets })) as RoomGroup[]
  }, [structureAssets])

  const observations = entityObservations(snapshot, selection)
  const siteLayout = snapshot.current_observations.find((o) => o.observation_key === 'site_layout_v0_1')
  const floorPlan = snapshot.current_observations.find((o) => o.observation_key === 'main_house_floor_plan_v0_1')
  const waterSystem = snapshot.systems.find((system) => system.system_type === 'water' && system.name.toLowerCase().includes('water'))
  const waterAssets = waterSystem ? snapshot.assets.filter((asset) => asset.system_id === waterSystem.id) : []
  const sensors = snapshot.sensor_devices ?? []
  const telemetry = snapshot.current_telemetry ?? []

  const entityName = selection.kind === 'property'
    ? snapshot.property.name
    : selection.kind === 'structure'
      ? snapshot.structures.find((s) => s.id === selection.id)?.name ?? 'Structure'
      : selection.kind === 'system'
        ? snapshot.systems.find((s) => s.id === selection.id)?.name ?? 'System'
        : selectedAsset?.name ?? 'Asset'

  const entityStatus = selection.kind === 'property'
    ? snapshot.property.status
    : selection.kind === 'structure'
      ? 'modeled'
      : selection.kind === 'system'
        ? selectedSystem?.status ?? 'unknown'
        : selectedAsset?.status ?? 'unknown'

  const entityMetadata = selection.kind === 'property'
    ? snapshot.property.metadata
    : selection.kind === 'structure'
      ? snapshot.structures.find((s) => s.id === selection.id)?.metadata
      : selection.kind === 'system'
        ? selectedSystem?.metadata
        : selectedAsset?.metadata

  return (
    <div style={{ minHeight: '100%', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', gap: 14, color: '#f4f4f5' }}>
      <div style={{ ...panel, padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <div>
          <div style={{ fontSize: 10, color: '#7f8189', textTransform: 'uppercase', letterSpacing: '.08em' }}>Property Intelligence · digital twin v0.1</div>
          <div style={{ fontSize: 20, fontWeight: 680, marginTop: 2 }}>{snapshot.property.name}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <StatusPill status={snapshot.property.status} />
          <span style={{ fontSize: 10, color: '#74767f' }}>schematic · known reality only · not surveyed</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '250px minmax(420px,1fr) 320px', gap: 12, minHeight: 0 }}>
        <aside style={{ ...panel, padding: 10, overflow: 'auto' }}>
          <div style={{ padding: '4px 5px 8px', color: '#777983', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.07em' }}>Property hierarchy</div>
          <button onClick={() => setSelection({ kind: 'property', id: snapshot.property.id })} style={treeButton(selection.kind === 'property')}>
            <span>⌂</span><span style={{ minWidth: 0 }}><strong>{snapshot.property.name}</strong><small>Property</small></span>
          </button>
          {snapshot.structures.map((structure) => {
            const open = selectedStructure?.id === structure.id
            const systems = snapshot.systems.filter((system) => system.structure_id === structure.id)
            const rooms = open ? roomGroups : []
            return (
              <div key={structure.id}>
                <button onClick={() => setSelection({ kind: 'structure', id: structure.id })} style={{ ...treeButton(selection.kind === 'structure' && selection.id === structure.id), marginLeft: 12, width: 'calc(100% - 12px)' }}>
                  <span>▱</span><span style={{ minWidth: 0 }}><strong>{structure.name}</strong><small>{structure.structure_type}</small></span>
                </button>
                {open && rooms.map((room) => (
                  <div key={room.name} style={{ margin: '3px 0 4px 26px', paddingLeft: 9, borderLeft: '1px solid rgba(255,255,255,.08)' }}>
                    <div style={{ color: '#8b8d95', fontSize: 10, padding: '4px 3px' }}>{room.name}</div>
                    {room.assets.map((asset) => (
                      <button key={asset.id} onClick={() => setSelection({ kind: 'asset', id: asset.id })} style={{ ...treeButton(selection.kind === 'asset' && selection.id === asset.id), padding: '5px 6px' }}>
                        <span style={{ color: statusColor(asset.status) }}>●</span><span style={{ minWidth: 0 }}><strong style={{ fontSize: 10.5 }}>{asset.name}</strong><small>{asset.asset_type}</small></span>
                      </button>
                    ))}
                  </div>
                ))}
                {open && systems.map((system) => (
                  <button key={system.id} onClick={() => setSelection({ kind: 'system', id: system.id })} style={{ ...treeButton(selection.kind === 'system' && selection.id === system.id), marginLeft: 26, width: 'calc(100% - 26px)', padding: '5px 6px' }}>
                    <span style={{ color: statusColor(system.status) }}>◇</span><span style={{ minWidth: 0 }}><strong style={{ fontSize: 10.5 }}>{system.name}</strong><small>{system.system_type}</small></span>
                  </button>
                ))}
              </div>
            )
          })}
          {snapshot.systems.filter((system) => !system.structure_id).length > 0 && <div style={{ padding: '13px 5px 5px', color: '#64666e', fontSize: 9.5 }}>PROPERTY SYSTEMS</div>}
          {snapshot.systems.filter((system) => !system.structure_id).map((system) => (
            <button key={system.id} onClick={() => setSelection({ kind: 'system', id: system.id })} style={{ ...treeButton(selection.kind === 'system' && selection.id === system.id), marginLeft: 12, width: 'calc(100% - 12px)' }}>
              <span style={{ color: statusColor(system.status) }}>◇</span><span style={{ minWidth: 0 }}><strong>{system.name}</strong><small>{system.system_type}</small></span>
            </button>
          ))}
        </aside>

        <main style={{ minWidth: 0, overflow: 'auto', display: 'grid', alignContent: 'start', gap: 12 }}>
          <section style={{ ...panel, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
              <div><div style={eyebrow}>Site topology</div><div style={{ fontSize: 14, fontWeight: 620 }}>Structures and known relationships</div></div>
              <div style={{ fontSize: 9.5, color: '#666872' }}>layout follows recorded sketch context, not survey coordinates</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 9 }}>
              {snapshot.structures.map((structure) => {
                const systemCount = snapshot.systems.filter((s) => s.structure_id === structure.id).length
                const assetCount = snapshot.assets.filter((a) => a.structure_id === structure.id).length
                const active = selectedStructure?.id === structure.id
                return (
                  <button key={structure.id} onClick={() => setSelection({ kind: 'structure', id: structure.id })} style={{
                    minHeight: structure.name.toLowerCase().includes('main house') ? 112 : 86,
                    border: active ? '1px solid rgba(99,200,200,.5)' : '1px solid rgba(255,255,255,.08)',
                    borderRadius: 12, background: active ? 'rgba(99,200,200,.08)' : 'rgba(255,255,255,.025)',
                    color: '#f4f4f5', textAlign: 'left', padding: 11, cursor: 'pointer',
                  }}>
                    <div style={{ fontSize: 12.5, fontWeight: 640 }}>{structure.name}</div>
                    <div style={{ fontSize: 9.5, color: '#858790', marginTop: 2 }}>{structure.structure_type}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 14, fontSize: 9.5, color: '#9a9ca4' }}><span>{systemCount} systems</span><span>{assetCount} assets</span></div>
                  </button>
                )
              })}
            </div>
            {siteLayout?.text_value && <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 9, background: 'rgba(255,255,255,.025)', color: '#8f9199', fontSize: 10.5, lineHeight: 1.45 }}>{siteLayout.text_value}</div>}
          </section>

          {selectedStructure && (
            <section style={{ ...panel, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                <div><div style={eyebrow}>Interior / zones</div><div style={{ fontSize: 14, fontWeight: 620 }}>{selectedStructure.name}</div></div>
                <span style={{ fontSize: 9.5, color: '#6f717a' }}>rooms inferred only from recorded asset locations</span>
              </div>
              {roomGroups.length ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 8 }}>
                  {roomGroups.map((room) => (
                    <div key={room.name} style={{ padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,.07)', background: 'rgba(255,255,255,.02)' }}>
                      <div style={{ fontSize: 11.5, fontWeight: 620, marginBottom: 7 }}>{room.name}</div>
                      {room.assets.map((asset) => (
                        <button key={asset.id} onClick={() => setSelection({ kind: 'asset', id: asset.id })} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '4px 0', border: 0, background: 'transparent', color: selection.kind === 'asset' && selection.id === asset.id ? '#7dd8e0' : '#c9cad0', cursor: 'pointer', textAlign: 'left', fontSize: 10.5 }}>
                          <span style={{ color: statusColor(asset.status), fontSize: 8 }}>●</span>{asset.name}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : <div style={{ color: '#71737c', fontSize: 11 }}>No room-level location data recorded yet.</div>}
              {selectedStructure.name.toLowerCase().includes('main house') && floorPlan?.text_value && <div style={{ marginTop: 10, color: '#80828b', fontSize: 10.5, lineHeight: 1.5 }}>{floorPlan.text_value}</div>}
            </section>
          )}

          {waterSystem && (
            <section style={{ ...panel, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                <div><div style={eyebrow}>System graph</div><div style={{ fontSize: 14, fontWeight: 620 }}>{waterSystem.name}</div></div>
                <button onClick={() => setSelection({ kind: 'system', id: waterSystem.id })} style={ghostButton}>Inspect system</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, overflowX: 'auto', paddingBottom: 3 }}>
                {waterAssets.map((asset, index) => (
                  <div key={asset.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {index > 0 && <span style={{ color: '#4f8d93', fontSize: 14 }}>→</span>}
                    <button onClick={() => setSelection({ kind: 'asset', id: asset.id })} style={{ minWidth: 118, padding: '8px 9px', borderRadius: 9, border: selection.kind === 'asset' && selection.id === asset.id ? '1px solid rgba(99,200,200,.55)' : '1px solid rgba(255,255,255,.07)', background: 'rgba(255,255,255,.025)', color: '#d8d9dd', cursor: 'pointer', textAlign: 'left' }}>
                      <div style={{ fontSize: 10.5, fontWeight: 600 }}>{asset.name}</div>
                      <div style={{ fontSize: 9, color: statusColor(asset.status), marginTop: 2 }}>{asset.status.replaceAll('_', ' ')}</div>
                    </button>
                  </div>
                ))}
              </div>
              {typeof waterSystem.metadata?.layout === 'string' && <div style={{ marginTop: 9, color: '#777983', fontSize: 10 }}>{waterSystem.metadata.layout}</div>}
            </section>
          )}

          <section style={{ ...panel, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
              <div><div style={eyebrow}>Live reality</div><div style={{ fontSize: 14, fontWeight: 620 }}>Sensors & telemetry</div></div>
              <div style={{ fontSize: 9.5, color: '#6f717a' }}>{telemetry.length ? `${telemetry.length} current measurements` : 'No live telemetry yet'}</div>
            </div>
            {sensors.length ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 8 }}>
              {sensors.map((sensor) => {
                const values = telemetry.filter((entry) => entry.device_id === sensor.id)
                const asset = snapshot.assets.find((item) => item.id === sensor.asset_id)
                return (
                  <div key={sensor.id} style={{ padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,.07)', background: 'rgba(255,255,255,.02)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><div style={{ fontSize: 11.5, fontWeight: 620 }}>{asset?.name ?? sensor.device_key}</div><StatusPill status={sensor.status} /></div>
                    <div style={{ fontSize: 9.5, color: '#777983', marginTop: 3 }}>{sensor.sensor_kind} · {sensor.provider}</div>
                    {values.length ? values.map((entry) => <div key={entry.id} style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10.5 }}><span style={{ color: '#888a92' }}>{titleCase(entry.metric_key)}</span><strong>{entry.numeric_value} {entry.unit}</strong></div>) : <div style={{ color: '#656770', fontSize: 10, marginTop: 9 }}>Hardware slot exists; no live reading has been recorded.</div>}
                  </div>
                )
              })}
            </div> : <div style={{ color: '#71737c', fontSize: 11 }}>No sensor devices registered for this property.</div>}
          </section>
        </main>

        <aside style={{ ...panel, padding: 13, overflow: 'auto' }}>
          <div style={eyebrow}>Inspector</div>
          <div style={{ fontSize: 17, fontWeight: 650, marginTop: 2 }}>{entityName}</div>
          <div style={{ marginTop: 7 }}><StatusPill status={entityStatus} /></div>

          {selectedAsset && <div style={{ marginTop: 14, display: 'grid', gap: 5, fontSize: 10.5 }}>
            <InfoRow label="Type" value={selectedAsset.asset_type} />
            {selectedAsset.manufacturer && <InfoRow label="Manufacturer" value={selectedAsset.manufacturer} />}
            {selectedAsset.model && <InfoRow label="Model" value={selectedAsset.model} />}
            {selectedSystem && <InfoRow label="System" value={selectedSystem.name} />}
            {selectedStructure && <InfoRow label="Structure" value={selectedStructure.name} />}
          </div>}

          {metadataRows(entityMetadata).length > 0 && <div style={{ marginTop: 16 }}>
            <div style={sectionTitle}>Recorded metadata</div>
            {metadataRows(entityMetadata).map(([key, value]) => <InfoRow key={key} label={titleCase(key)} value={String(value)} />)}
          </div>}

          <div style={{ marginTop: 16 }}>
            <div style={sectionTitle}>Current known state</div>
            {observations.length ? observations.slice(0, 16).map((observation) => (
              <div key={observation.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.055)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ color: '#8c8e96', fontSize: 9.5 }}>{titleCase(observation.observation_key)}</span><span style={{ color: provenanceColor(observation.provenance_status), fontSize: 9 }}>{observation.provenance_status}</span></div>
                <div style={{ fontSize: 11.5, color: '#d7d8dc', marginTop: 3, lineHeight: 1.42 }}>{valueFor(observation)}</div>
                {observation.notes && <div style={{ fontSize: 9.5, color: '#696b74', marginTop: 3, lineHeight: 1.4 }}>{observation.notes}</div>}
              </div>
            )) : <div style={{ color: '#666872', fontSize: 10.5, marginTop: 7 }}>No direct observations recorded for this selection.</div>}
          </div>
        </aside>
      </div>
    </div>
  )
}

function treeButton(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 7px', border: 0, borderRadius: 8,
    background: active ? 'rgba(99,200,200,.09)' : 'transparent', color: active ? '#7dd8e0' : '#c6c7cc', cursor: 'pointer', textAlign: 'left',
  }
}

const eyebrow: React.CSSProperties = { color: '#777983', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 3 }
const sectionTitle: React.CSSProperties = { color: '#777983', fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }
const ghostButton: React.CSSProperties = { border: '1px solid rgba(255,255,255,.08)', borderRadius: 8, background: 'rgba(255,255,255,.025)', color: '#aeb0b7', padding: '5px 8px', fontSize: 9.5, cursor: 'pointer' }

function provenanceColor(status: string) {
  if (status === 'measured') return '#66d1a6'
  if (status === 'operator_confirmed') return '#7dd8e0'
  if (status === 'observed') return '#b9c9d6'
  if (status === 'estimated') return '#d7b65d'
  return '#9a8fd1'
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '95px minmax(0,1fr)', gap: 8, padding: '4px 0', fontSize: 10.5 }}><span style={{ color: '#777983' }}>{label}</span><span style={{ color: '#c8c9ce', overflowWrap: 'anywhere' }}>{value}</span></div>
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
  if (!snapshot) return <div style={{ padding: 10, border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, fontSize: 12, color: '#a1a1aa' }}>Loading digital property…</div>

  return (
    <>
      <CompactPropertyModel snapshot={snapshot} onExpand={() => setExpanded(true)} />
      <FullscreenResultOverlay open={expanded} title={`${snapshot.property.name} · Digital Twin`} onClose={() => setExpanded(false)}>
        <DigitalTwin snapshot={snapshot} />
      </FullscreenResultOverlay>
    </>
  )
}
