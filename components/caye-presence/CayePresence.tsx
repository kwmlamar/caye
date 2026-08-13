'use client'

import dynamic from 'next/dynamic'
import { useEffect, useMemo, useState } from 'react'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { hasWebGL } from '@/lib/caye-presence/webgl-support'
import { useAudioLevelSource, type CayePresenceAudioSource } from '@/lib/caye-presence/useAudioLevelSource'
import type { CayePresenceState } from '@/lib/caye-presence/state-params'
import { CayePresenceFallback } from './CayePresenceFallback'

export type { CayePresenceState, CayePresenceAudioSource }

// The WebGL scene is dynamically imported with ssr:false — three.js
// touches `window` at module scope in places and must never execute
// during server rendering.
const CayePresenceScene = dynamic(
  () => import('./CayePresenceScene').then((m) => m.CayePresenceScene),
  { ssr: false }
)

export type CayePresenceSize = 'small' | 'medium' | 'large' | number

const SIZE_MAP: Record<'small' | 'medium' | 'large', number> = {
  small: 96,
  medium: 200,
  large: 340,
}

function resolveSize(size: CayePresenceSize): number {
  return typeof size === 'number' ? size : SIZE_MAP[size]
}

const STATE_LABEL: Record<CayePresenceState, string> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
}

/**
 * Caye's visual presence — a living particle sphere standing in for "an
 * active AI employee is here," not a decorative loading spinner. Fully
 * decoupled from any one page: state and audio come in as props, and the
 * render/audio/motion logic lives in lib/caye-presence + this directory so
 * the same component can be dropped in anywhere Caye needs a face.
 *
 * `audioSource` accepts an HTMLMediaElement, a MediaStream (e.g. a mic
 * input for a listening demo), or a caller-owned AnalyserNode (for when a
 * future TTS playback pipeline wants to hand over just the tap point). See
 * lib/caye-presence/useAudioLevelSource.ts for the wiring, and
 * app/dev/caye-presence for a working demo of all four states plus a
 * microphone-driven `speaking` example — there is no live Caye voice
 * output yet (see voice-calling-roadmap.md) so nothing today can wire
 * `speaking` to real outgoing audio; that's the one thing left to connect
 * once TTS exists.
 */
export function CayePresence({
  state = 'idle',
  audioSource,
  size = 'medium',
  interactive = true,
  className,
}: {
  state?: CayePresenceState
  audioSource?: CayePresenceAudioSource
  size?: CayePresenceSize
  interactive?: boolean
  className?: string
}) {
  const px = resolveSize(size)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const isSmallViewport = useMediaQuery('(max-width: 640px)')
  const [webglReady, setWebglReady] = useState(false)

  useEffect(() => {
    setWebglReady(hasWebGL())
  }, [])

  const getLevel = useAudioLevelSource(audioSource)

  // Fewer particles on small viewports — the object also renders smaller
  // there, so density loss isn't very visible, and it keeps phones smooth.
  // A conservative bump at large rendered sizes (e.g. the dashboard hero at
  // ~420-480px) keeps density from thinning out as the same particle count
  // covers more screen area — scaled by the resolved pixel size, not
  // blindly doubled, since most consumers (the small Caye Direct avatar,
  // the dev demo's "large"=340) don't need it.
  const particleCount = useMemo(() => {
    if (isSmallViewport) return 1400
    if (px >= 700) return 6000
    if (px >= 460) return 4200
    if (px >= 380) return 3600
    return 3200
  }, [isSmallViewport, px])

  return (
    <div className={className} style={{ position: 'relative', width: px, height: px, flexShrink: 0 }}>
      <span
        className="sr-only"
        aria-live="polite"
        style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
      >
        Caye is {STATE_LABEL[state]}
      </span>
      {webglReady ? (
        <CayePresenceScene
          state={state}
          particleCount={particleCount}
          getLevel={getLevel}
          reducedMotion={reducedMotion}
          interactive={interactive}
        />
      ) : (
        <CayePresenceFallback state={state} size={px} />
      )}
    </div>
  )
}
