'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { Canvas, useLoader, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { getSession } from '@/lib/supabase'
import { ExpandResultButton, FullscreenResultOverlay } from './FullscreenResultOverlay'

type Artifact = { id: string; revision: number; name: string; dimensions: { x?: number; y?: number; z?: number } | { bounds_mm?: Record<string, number> }; calculationMetadata: { volume_mm3?: number; disclaimer?: string }; parentArtifactId: string | null; preview: { url: string; mediaType: string } }
function Controls() { const { camera, gl } = useThree(); const ref = useRef<OrbitControls | null>(null); useEffect(() => { const c = new OrbitControls(camera, gl.domElement); c.enableDamping = true; ref.current = c; return () => c.dispose() }, [camera, gl]); return null }
function Mesh({ url }: { url: string }) { const geometry = useLoader(STLLoader, url); useEffect(() => { geometry.center(); geometry.computeBoundingSphere() }, [geometry]); return <mesh geometry={geometry}><meshStandardMaterial color="#4EBECE" roughness={0.5} metalness={0.12} /></mesh> }

function ArtifactViewer({ artifact, expanded, reset, onReset, onExpand }: { artifact: Artifact; expanded?: boolean; reset: number; onReset: () => void; onExpand?: () => void }) {
  const b: Record<string, number> | undefined = ('bounds_mm' in artifact.dimensions ? artifact.dimensions.bounds_mm : artifact.dimensions) as Record<string, number> | undefined
  return (
    <section style={{
      marginTop: expanded ? 0 : 12,
      border: '1px solid rgba(78,190,206,.32)',
      borderRadius: 12,
      overflow: 'hidden',
      background: 'rgba(78,190,206,.05)',
      minWidth: 300,
      height: expanded ? '100%' : undefined,
      display: expanded ? 'grid' : undefined,
      gridTemplateRows: expanded ? '48px minmax(0,1fr) 42px auto' : undefined,
    }}>
      <div style={{ padding: expanded ? '12px 14px' : '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: expanded ? 15 : 12, fontWeight: 700 }}>{artifact.name}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: '#72cfd9' }}>REV {artifact.revision}</span>
          {!expanded && onExpand ? <ExpandResultButton onClick={onExpand} label={`Open ${artifact.name} revision ${artifact.revision} full screen`} /> : null}
        </div>
      </div>
      <div style={{ height: expanded ? '100%' : 240, minHeight: expanded ? 0 : undefined, background: '#101315' }} key={`${reset}-${expanded ? 'full' : 'inline'}`}>
        <Canvas camera={{ position: [130, 110, 150], fov: 45 }}>
          <ambientLight intensity={1.2} />
          <directionalLight position={[80, 120, 100]} intensity={2} />
          <Suspense fallback={null}><Mesh url={artifact.preview.url} /></Suspense>
          <Controls />
        </Canvas>
      </div>
      <div style={{ padding: expanded ? '10px 14px' : '9px 12px', display: 'flex', justifyContent: 'space-between', fontSize: expanded ? 12 : 10.5, color: '#b8b8bf' }}>
        <span>{b ? `${Number(b.x ?? 0).toFixed(1)} × ${Number(b.y ?? 0).toFixed(1)} × ${Number(b.z ?? 0).toFixed(1)} mm` : 'Bounds pending'}</span>
        <button type="button" onClick={onReset} style={{ border: 0, background: 'transparent', color: '#72cfd9', cursor: 'pointer', font: 'inherit' }}>Reset view</button>
      </div>
      <p style={{ margin: expanded ? '0 14px 14px' : '0 12px 11px', fontSize: expanded ? 11 : 10, color: '#8e8e96', lineHeight: 1.4 }}>{artifact.calculationMetadata.disclaimer ?? 'Geometry preview only; it is not structural verification.'}</p>
    </section>
  )
}

/** Trusted result: only an artifact id crosses the chat boundary; this component obtains a signed URL after server-side authorization. */
export function EngineeringArtifactResult({ artifactId, workspaceId }: { artifactId: string; workspaceId: string }) {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [error, setError] = useState(false)
  const [reset, setReset] = useState(0)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { let cancelled = false; (async () => { const { session } = await getSession(); if (!session) return; const res = await fetch(`/api/founder/engineering-artifacts/${artifactId}?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${session.access_token}` } }); const json = await res.json(); if (!cancelled) { if (res.ok) setArtifact(json.artifact); else setError(true) } })(); return () => { cancelled = true } }, [artifactId, workspaceId])
  if (error) return <div style={{ color: '#a1a1aa', fontSize: 12 }}>Engineering preview is unavailable.</div>
  if (!artifact) return <div style={{ color: '#a1a1aa', fontSize: 12 }}>Loading engineering artifact…</div>
  return (
    <>
      <ArtifactViewer artifact={artifact} reset={reset} onReset={() => setReset((n) => n + 1)} onExpand={() => setExpanded(true)} />
      <FullscreenResultOverlay open={expanded} title={`${artifact.name} · REV ${artifact.revision}`} onClose={() => setExpanded(false)}>
        <ArtifactViewer artifact={artifact} expanded reset={reset} onReset={() => setReset((n) => n + 1)} />
      </FullscreenResultOverlay>
    </>
  )
}
