'use client'

import { useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { ParticleSphere } from './ParticleSphere'
import type { CayePresenceState } from '@/lib/caye-presence/state-params'

/** The actual WebGL scene — split out from CayePresence so it can be
 *  loaded with `next/dynamic({ ssr: false })`. Three.js touches `window`
 *  at module scope in places, so this must never execute during SSR. */
export function CayePresenceScene({
  state,
  particleCount,
  getLevel,
  reducedMotion,
  interactive,
}: {
  state: CayePresenceState
  particleCount: number
  getLevel: () => number
  reducedMotion: boolean
  interactive: boolean
}) {
  const [tabVisible, setTabVisible] = useState(true)

  useEffect(() => {
    const onVisibility = () => setTabVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  return (
    <Canvas
      camera={{ position: [0, 0, 2.6], fov: 40 }}
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
      frameloop={tabVisible ? 'always' : 'never'}
      style={{ background: 'transparent', touchAction: interactive ? 'none' : 'auto' }}
    >
      <ParticleSphere
        state={state}
        particleCount={particleCount}
        getLevel={getLevel}
        reducedMotion={reducedMotion}
        interactive={interactive}
      />
    </Canvas>
  )
}
