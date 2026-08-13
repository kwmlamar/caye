'use client'

import { useMemo, useRef } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { AQUA, GOLD } from '@/components/dashboard/surface'
import { smoothLevel } from '@/lib/caye-presence/audio-level'
import {
  getStateParams,
  lerpStateParams,
  transitionStep,
  type CayePresenceState,
  type StateParams,
} from '@/lib/caye-presence/state-params'
import { PARTICLE_FRAGMENT_SHADER, PARTICLE_VERTEX_SHADER } from './shaders'

// Caye's brand cream token (app/globals.css --color-cream) — not exported
// from surface.ts (a dark-palette-only module), used here as a very small
// accent so interior particles read as warmer, not multicolor.
const CREAM = '#FAF7F2'

// Camera sits at distance 2.6 with fov 40° (half-fov 20°) — unchanged.
// The visible sphere's size on screen is governed by BASE_RADIUS/distance,
// not by the wrapper's pixel dimensions, so growing the CayePresence
// `size` prop alone (a CSS/Canvas change) does nothing to how much of that
// box the sphere itself fills — this constant is the actual lever.
// 0.67 puts the sphere's rest silhouette at asin(0.67/2.6)≈15° (~75% of
// the 20° half-fov, ~73% linear fill of the Canvas) — up from 0.48's ~51%
// fill. That's tighter than the old 54%-of-half-fov margin, but the
// dashboard only ever drives idle/thinking here (see toPresenceState in
// FounderBriefing.tsx — no audio source is connected), whose combined
// breathe+noise displacement tops out around 1.15x rest radius, well
// inside the frustum. A sustained max-loudness `speaking` spike (only
// reachable via the mic-driven dev demo today, not production) could
// graze the edge on an outlier particle — a rare, brief, single-particle
// event, not the permanent full-silhouette clipping the old too-small
// margin caused.
const BASE_RADIUS = 0.67
// Scaled with BASE_RADIUS (proportional to the 1.7 tuned for 0.48) plus a
// touch more for the larger dashboard presence — tune here to make
// particles chunkier/finer independent of radius.
const BASE_POINT_SIZE = 2.4
// Must match the camera's `position.z` in CayePresenceScene.tsx — used to
// keep point size roughly constant on-screen regardless of camera setup.
const CAMERA_FOCUS_DISTANCE = 2.6

// How far a drag can tilt the object off its resting X rotation, and how
// quickly it eases back once released — "gently settle back," not a spring.
const DRAG_TILT_LIMIT = 0.8
const DRAG_SETTLE_RATE_PER_SEC = 2.6
const DRAG_SENSITIVITY = 0.006

function buildGeometry(count: number) {
  const dirs = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)
  const radiusScales = new Float32Array(count)
  // Fibonacci sphere for even base coverage, then a small per-particle
  // jitter + renormalize so it reads as an organic cloud rather than a
  // perfectly regular lattice.
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const jitter = 0.07
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = goldenAngle * i
    let x = Math.cos(theta) * radiusAtY
    let z = Math.sin(theta) * radiusAtY
    let yy = y

    x += (Math.random() - 0.5) * jitter
    yy += (Math.random() - 0.5) * jitter
    z += (Math.random() - 0.5) * jitter
    const len = Math.sqrt(x * x + yy * yy + z * z) || 1
    dirs[i * 3] = x / len
    dirs[i * 3 + 1] = yy / len
    dirs[i * 3 + 2] = z / len

    seeds[i] = Math.random()
    sizes[i] = 0.55 + Math.random() * 0.9

    // Interior depth: almost all particles stay near the outer shell
    // (this is still a cloud, not a filled ball) but a cubed-random tail
    // pulls a minority inward, so the silhouette isn't a perfectly hollow
    // shell when viewed face-on. Rare and shallow on purpose.
    radiusScales[i] = 1 - Math.pow(Math.random(), 3) * 0.34
  }
  return { dirs, seeds, sizes, radiusScales }
}

export function ParticleSphere({
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
  const groupRef = useRef<THREE.Group>(null)
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  const geometry = useMemo(() => {
    const { dirs, seeds, sizes, radiusScales } = buildGeometry(particleCount)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(dirs, 3)) // required by three; unused directly, aDir drives placement
    geo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geo.setAttribute('aRadiusScale', new THREE.BufferAttribute(radiusScales, 1))
    return geo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [particleCount])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uRadius: { value: BASE_RADIUS },
      uNoiseAmount: { value: 0.06 },
      uNoiseSpeed: { value: 0.12 },
      uAudioLevel: { value: 0 },
      uAudioDisplacementGain: { value: 0.05 },
      uBaseSize: { value: BASE_POINT_SIZE },
      uPixelRatio: { value: 1 },
      uFocusDistance: { value: CAMERA_FOCUS_DISTANCE },
      uColorCool: { value: new THREE.Color(AQUA) },
      uColorWarm: { value: new THREE.Color(GOLD) },
      uColorAccent: { value: new THREE.Color(CREAM) },
      uColorWarmth: { value: 0.08 },
      uGlowIntensity: { value: 0.2 },
    }),
    []
  )

  // Mutable, per-frame state that must never live in React state (would
  // re-render every animation frame). Refs only.
  const liveParams = useRef<StateParams>(getStateParams('idle'))
  const smoothedLevelRef = useRef(0)
  const autoRotationY = useRef(0)
  const dragOffset = useRef({ x: 0, y: 0 })
  const dragging = useRef(false)
  const lastPointer = useRef({ x: 0, y: 0 })

  useFrame(({ clock, gl }, delta) => {
    const dt = Math.min(delta, 1 / 20) // clamp so a tab-switch stutter doesn't jump the sim
    const time = clock.elapsedTime
    const target = getStateParams(state)
    const step = transitionStep(dt)
    liveParams.current = lerpStateParams(liveParams.current, target, step)
    const p = liveParams.current

    const rawLevel = getLevel()
    smoothedLevelRef.current = smoothLevel(smoothedLevelRef.current, rawLevel, dt)
    const level = smoothedLevelRef.current

    const motionScale = reducedMotion ? 0 : 1
    // Reduced motion: autonomous rotation/drift/breathing (purely
    // decorative) stop entirely, per prefers-reduced-motion. Audio-driven
    // displacement is content, not decoration, so it's damped rather than
    // removed — Caye still visibly reacts to her own speech, just gently.
    const audioMotionScale = reducedMotion ? 0.4 : 1

    autoRotationY.current += p.rotationSpeed * motionScale * dt

    if (interactive && !dragging.current) {
      const settle = 1 - Math.exp(-DRAG_SETTLE_RATE_PER_SEC * dt)
      dragOffset.current.x += (0 - dragOffset.current.x) * settle
      dragOffset.current.y += (0 - dragOffset.current.y) * settle
    }

    const driftX = Math.sin(time * p.driftSpeed) * p.driftAmount * motionScale
    const driftZ = Math.cos(time * p.driftSpeed * 0.7) * p.driftAmount * 0.6 * motionScale

    if (groupRef.current) {
      groupRef.current.rotation.y = autoRotationY.current + dragOffset.current.y
      groupRef.current.rotation.x = driftX + dragOffset.current.x
      groupRef.current.rotation.z = driftZ

      const breathe = 1 + Math.sin(time * p.breatheSpeed) * p.breatheAmount * motionScale
      const audioScale = 1 + level * p.audioScaleGain * audioMotionScale
      const scale = p.radiusScale * breathe * audioScale
      groupRef.current.scale.setScalar(scale)
    }

    const mat = materialRef.current
    if (mat) {
      mat.uniforms.uTime.value = time
      mat.uniforms.uNoiseAmount.value = p.noiseAmount * motionScale
      mat.uniforms.uNoiseSpeed.value = p.noiseSpeed
      mat.uniforms.uAudioLevel.value = level * audioMotionScale
      mat.uniforms.uAudioDisplacementGain.value = p.audioDisplacementGain
      mat.uniforms.uColorWarmth.value = p.colorWarmth
      mat.uniforms.uGlowIntensity.value = 0.2 + level * p.audioGlowGain
      mat.uniforms.uPixelRatio.value = gl.getPixelRatio()
    }
  })

  function handlePointerDown(e: ThreeEvent<PointerEvent>) {
    if (!interactive) return
    dragging.current = true
    lastPointer.current = { x: e.clientX, y: e.clientY }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  function handlePointerMove(e: ThreeEvent<PointerEvent>) {
    if (!interactive || !dragging.current) return
    const dx = e.clientX - lastPointer.current.x
    const dy = e.clientY - lastPointer.current.y
    lastPointer.current = { x: e.clientX, y: e.clientY }
    dragOffset.current.y += dx * DRAG_SENSITIVITY
    dragOffset.current.x = Math.max(
      -DRAG_TILT_LIMIT,
      Math.min(DRAG_TILT_LIMIT, dragOffset.current.x + dy * DRAG_SENSITIVITY)
    )
  }

  function handlePointerUp() {
    dragging.current = false
  }

  return (
    <group ref={groupRef}>
      <points geometry={geometry}>
        <shaderMaterial
          ref={materialRef}
          vertexShader={PARTICLE_VERTEX_SHADER}
          fragmentShader={PARTICLE_FRAGMENT_SHADER}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      {interactive && (
        <mesh
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerOut={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <sphereGeometry args={[BASE_RADIUS * 1.15, 12, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}
