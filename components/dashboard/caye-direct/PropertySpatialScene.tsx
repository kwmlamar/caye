'use client'

import { Canvas } from '@react-three/fiber'
import { useMemo, useState } from 'react'
import type { ThreeEvent } from '@react-three/fiber'

type Structure = { id: string; name: string; structure_type: string }

type SiteNode = {
  id: string
  name: string
  type: 'building' | 'utility' | 'tank_pad' | 'shed'
  x: number
  z: number
  w: number
  d: number
  h: number
}

const SITE_LAYOUT: Record<string, Omit<SiteNode, 'id' | 'name'>> = {
  'main house': { type: 'building', x: -1.6, z: 1.4, w: 5.2, d: 3.8, h: 1.65 },
  'front house': { type: 'building', x: -2.2, z: -3.1, w: 3.2, d: 2.35, h: 1.35 },
  'water tank pad': { type: 'tank_pad', x: 3.5, z: -3.4, w: 2.8, d: 2.1, h: 0.25 },
  shed: { type: 'shed', x: 3.45, z: 0.3, w: 2.0, d: 1.55, h: 1.0 },
  'pump house': { type: 'utility', x: 4.25, z: 3.7, w: 1.55, d: 1.3, h: 0.85 },
}

function structureNode(structure: Structure, index: number): SiteNode {
  const known = SITE_LAYOUT[structure.name.toLowerCase()]
  if (known) return { id: structure.id, name: structure.name, ...known }
  return { id: structure.id, name: structure.name, type: 'utility', x: index * 2.4 - 3, z: 5, w: 1.8, d: 1.4, h: 0.9 }
}

function Building({ node, selected, onSelect }: { node: SiteNode; selected: boolean; onSelect: () => void }) {
  const base = selected ? '#69d1d3' : node.type === 'building' ? '#8b9699' : node.type === 'tank_pad' ? '#677276' : '#737c7f'
  const roof = selected ? '#9ce7e6' : '#5e676a'
  const isMain = node.name.toLowerCase() === 'main house'

  return (
    <group position={[node.x, 0, node.z]} onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect() }}>
      {isMain ? (
        <>
          <mesh position={[-0.65, node.h / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[node.w * 0.72, node.h, node.d]} />
            <meshStandardMaterial color={base} roughness={0.82} />
          </mesh>
          <mesh position={[node.w * 0.32, node.h / 2, 0.68]} castShadow receiveShadow>
            <boxGeometry args={[node.w * 0.36, node.h, node.d * 0.64]} />
            <meshStandardMaterial color={base} roughness={0.82} />
          </mesh>
          <mesh position={[-0.65, node.h + 0.28, 0]} rotation={[0, 0, 0]} castShadow>
            <coneGeometry args={[3.25, 0.58, 4]} />
            <meshStandardMaterial color={roof} roughness={0.9} />
          </mesh>
        </>
      ) : node.type === 'tank_pad' ? (
        <>
          <mesh position={[0, node.h / 2, 0]} receiveShadow>
            <boxGeometry args={[node.w, node.h, node.d]} />
            <meshStandardMaterial color={base} roughness={0.95} />
          </mesh>
          {[-0.67, 0.67].map((offset) => (
            <mesh key={offset} position={[offset, 1.02, 0]} castShadow receiveShadow>
              <cylinderGeometry args={[0.72, 0.72, 1.75, 28]} />
              <meshStandardMaterial color={selected ? '#7fdcdf' : '#202628'} roughness={0.85} />
            </mesh>
          ))}
        </>
      ) : (
        <>
          <mesh position={[0, node.h / 2, 0]} castShadow receiveShadow>
            <boxGeometry args={[node.w, node.h, node.d]} />
            <meshStandardMaterial color={base} roughness={0.88} />
          </mesh>
          <mesh position={[0, node.h + 0.22, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
            <coneGeometry args={[Math.max(node.w, node.d) * 0.75, 0.45, 4]} />
            <meshStandardMaterial color={roof} roughness={0.92} />
          </mesh>
        </>
      )}
    </group>
  )
}

function Scene({ nodes, selectedId, onSelect, rotation }: { nodes: SiteNode[]; selectedId?: string; onSelect: (id: string) => void; rotation: number }) {
  return (
    <>
      <ambientLight intensity={1.35} />
      <directionalLight position={[7, 10, 6]} intensity={2.4} castShadow />
      <directionalLight position={[-5, 4, -6]} intensity={0.55} />
      <group rotation={[0, rotation, 0]}>
        <mesh position={[0, -0.12, 0]} receiveShadow>
          <boxGeometry args={[14, 0.2, 12]} />
          <meshStandardMaterial color="#151a1b" roughness={1} />
        </mesh>
        <gridHelper args={[14, 14, '#293335', '#20292b']} position={[0, 0, 0]} />
        {nodes.map((node) => <Building key={node.id} node={node} selected={node.id === selectedId} onSelect={() => onSelect(node.id)} />)}
      </group>
    </>
  )
}

export function PropertySpatialScene({ structures, selectedStructureId, onSelectStructure }: { structures: Structure[]; selectedStructureId?: string; onSelectStructure: (id: string) => void }) {
  const [rotation, setRotation] = useState(-0.35)
  const nodes = useMemo(() => structures.map(structureNode), [structures])

  return (
    <div style={{ position: 'relative', height: 430, minHeight: 320, overflow: 'hidden', borderRadius: 14, border: '1px solid rgba(255,255,255,.08)', background: 'linear-gradient(180deg,#111719 0%,#0b0e10 100%)' }}>
      <Canvas shadows camera={{ position: [9, 10.5, 12], fov: 38 }} dpr={[1, 1.5]}>
        <Scene nodes={nodes} selectedId={selectedStructureId} onSelect={onSelectStructure} rotation={rotation} />
      </Canvas>
      <div style={{ position: 'absolute', left: 12, bottom: 11, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setRotation((value) => value - Math.PI / 8)} style={controlButton}>↶ Rotate</button>
        <button type="button" onClick={() => setRotation((value) => value + Math.PI / 8)} style={controlButton}>Rotate ↷</button>
        <button type="button" onClick={() => setRotation(-0.35)} style={controlButton}>Reset</button>
      </div>
      <div style={{ position: 'absolute', right: 12, bottom: 12, maxWidth: 300, padding: '7px 9px', borderRadius: 9, border: '1px solid rgba(255,255,255,.08)', background: 'rgba(7,10,11,.78)', color: '#898c93', fontSize: 9.5, lineHeight: 1.4 }}>
        Schematic 3D from recorded sketch relationships. Shape, spacing, orientation and roof geometry are not surveyed.
      </div>
    </div>
  )
}

const controlButton: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,.11)',
  background: 'rgba(10,14,15,.82)',
  color: '#c9cbcf',
  borderRadius: 8,
  padding: '7px 9px',
  fontSize: 10,
  cursor: 'pointer',
}
