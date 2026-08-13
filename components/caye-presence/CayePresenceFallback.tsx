'use client'

import { useId } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { AQUA, GOLD } from '@/components/dashboard/surface'
import { useMediaQuery } from '@/lib/useMediaQuery'
import type { CayePresenceState } from '@/lib/caye-presence/state-params'

const STATE_COLOR: Record<CayePresenceState, string> = {
  idle: AQUA,
  listening: AQUA,
  thinking: GOLD,
  speaking: GOLD,
}

const STATE_SPEED_MS: Record<CayePresenceState, number> = {
  idle: 2600,
  listening: 1900,
  thinking: 1300,
  speaking: 950,
}

/** CSS-only stand-in for when WebGL is unavailable — same breathing-pulse
 *  language as CayeLoadingPulse, sized and colored to track state so
 *  swapping to/from the real scene (e.g. across a browser that gains/loses
 *  WebGL support) doesn't feel like a different component. */
export function CayePresenceFallback({ state, size }: { state: CayePresenceState; size: number }) {
  const rawId = useId().replace(/[:]/g, '')
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const color = STATE_COLOR[state]
  const markSize = Math.round(size * 0.4)

  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <style>{`
        @keyframes ${rawId}-pulse {
          0%, 100% { opacity: 0.45; transform: scale(0.92); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: size * 0.08,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${color}33, transparent 70%)`,
          animation: reduced ? 'none' : `${rawId}-pulse ${STATE_SPEED_MS[state]}ms ease-in-out infinite`,
        }}
      />
      <CayeMark size={markSize} />
    </div>
  )
}
