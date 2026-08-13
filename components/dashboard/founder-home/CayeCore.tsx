'use client'

import { useId, memo } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { useMediaQuery } from '@/lib/useMediaQuery'

/**
 * Caye's visual presence — a small intelligence at the center of a field
 * of orbital activity, not a status badge. Generalized so the same
 * component can eventually live anywhere in the product.
 *
 * States are a UI abstraction, not a promise the backend already emits
 * all six. Today four are wired to something real (see FounderHome):
 *   - idle       default, nothing notable happening
 *   - working    a route fetch is actually in flight
 *   - attention  a real open escalation exists — genuinely needs the founder
 *   - error      a connected channel actually needs reauth / is down
 * `thinking` and `speaking` have no real signal yet (would come from
 * lifting CayeDirectThread's `sending` state, or eventually a live-call
 * runtime — see voice-calling-roadmap.md, not started). The prop accepts
 * them now so nothing has to change here when that wiring exists.
 */
export type CayeState = 'idle' | 'working' | 'thinking' | 'speaking' | 'attention' | 'error'

const AQUA = '#4EBECE'
const GOLD = '#FFE4AF'
const ROSE = '#fb7185'
const CX = 200
const CY = 200
const R_OUTER = 165
const R_MID = 115
const R_INNER = 70
const R_CORE = 42

function orbitPath(r: number, clockwise: boolean): string {
  const sweep = clockwise ? 1 : 0
  return `M ${CX + r},${CY} A ${r},${r} 0 1,${sweep} ${CX - r},${CY} A ${r},${r} 0 1,${sweep} ${CX + r},${CY}`
}

// A straight radial line at `angleDeg` from the outer track down to the
// core — used for the "particle entering/leaving the system" traveler.
// Two travelers at different angles read as distinct events; the same
// line twice would just look like one particle lagging itself.
function radialPath(angleDeg: number): string {
  const rad = (angleDeg * Math.PI) / 180
  const ox = CX + R_OUTER * Math.cos(rad)
  const oy = CY + R_OUTER * Math.sin(rad)
  const ix = CX + R_CORE * Math.cos(rad)
  const iy = CY + R_CORE * Math.sin(rad)
  return `M ${ox},${oy} L ${ix},${iy}`
}

interface StateVisual {
  outerMs: number; midMs: number
  outerParticleMs: number; midParticleMs: number
  breatheMs: number; breatheScale: [number, number]
  outerOpacity: number; midOpacity: number; fieldOpacity: number
  travelers: boolean; waveform: boolean; gather: boolean; attentionBoost: boolean; restrained: boolean
}

const STATE_VISUAL: Record<CayeState, StateVisual> = {
  idle: {
    outerMs: 90000, midMs: 70000, outerParticleMs: 16000, midParticleMs: 12000,
    breatheMs: 4200, breatheScale: [0.97, 1.02],
    outerOpacity: 0.22, midOpacity: 0.16, fieldOpacity: 0.06,
    travelers: false, waveform: false, gather: false, attentionBoost: false, restrained: false,
  },
  working: {
    outerMs: 46000, midMs: 34000, outerParticleMs: 9000, midParticleMs: 7000,
    breatheMs: 2600, breatheScale: [0.96, 1.05],
    outerOpacity: 0.32, midOpacity: 0.24, fieldOpacity: 0.09,
    travelers: true, waveform: false, gather: false, attentionBoost: false, restrained: false,
  },
  thinking: {
    outerMs: 30000, midMs: 22000, outerParticleMs: 6000, midParticleMs: 4600,
    breatheMs: 1800, breatheScale: [0.94, 1.03],
    outerOpacity: 0.3, midOpacity: 0.28, fieldOpacity: 0.11,
    travelers: true, waveform: false, gather: true, attentionBoost: false, restrained: false,
  },
  speaking: {
    outerMs: 40000, midMs: 30000, outerParticleMs: 8000, midParticleMs: 6000,
    breatheMs: 1500, breatheScale: [0.97, 1.03],
    outerOpacity: 0.3, midOpacity: 0.32, fieldOpacity: 0.1,
    travelers: false, waveform: true, gather: false, attentionBoost: false, restrained: false,
  },
  attention: {
    outerMs: 50000, midMs: 26000, outerParticleMs: 10000, midParticleMs: 5200,
    breatheMs: 2400, breatheScale: [0.97, 1.03],
    outerOpacity: 0.26, midOpacity: 0.4, fieldOpacity: 0.1,
    travelers: false, waveform: false, gather: false, attentionBoost: true, restrained: false,
  },
  error: {
    outerMs: 110000, midMs: 90000, outerParticleMs: 20000, midParticleMs: 16000,
    breatheMs: 5200, breatheScale: [0.98, 1.01],
    outerOpacity: 0.14, midOpacity: 0.12, fieldOpacity: 0.05,
    travelers: false, waveform: false, gather: false, attentionBoost: false, restrained: true,
  },
}

const STATE_LABEL: Record<CayeState, string> = {
  idle: 'idle', working: 'working', thinking: 'thinking',
  speaking: 'speaking', attention: 'waiting on you', error: 'flagging an issue',
}

const WAVE_ANGLES = [0, 60, 120, 180, 240, 300]

function CayeCoreImpl({ state = 'idle', size = 340 }: { state?: CayeState; size?: number }) {
  const rawId = useId().replace(/[:]/g, '')
  const v = STATE_VISUAL[state]
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  const markSize = Math.round(size * 0.135)

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <span className="sr-only" aria-live="polite" style={{
        position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
      }}>
        Caye is {STATE_LABEL[state]}
      </span>

      <style>{`
        @keyframes ${rawId}-spin-cw   { from { transform: rotate(0deg); }   to { transform: rotate(360deg); } }
        @keyframes ${rawId}-spin-ccw  { from { transform: rotate(0deg); }   to { transform: rotate(-360deg); } }
        @keyframes ${rawId}-breathe   { 0%, 100% { transform: scale(${v.breatheScale[0]}); } 50% { transform: scale(${v.breatheScale[1]}); } }
        @keyframes ${rawId}-wave      { 0%, 100% { transform: scaleY(0.4); opacity: 0.35; } 50% { transform: scaleY(1); opacity: 0.9; } }
        .${rawId}-outer-ring  { animation: ${rawId}-spin-cw ${v.outerMs}ms linear infinite; transform-origin: ${CX}px ${CY}px; }
        .${rawId}-mid-ring    { animation: ${rawId}-spin-ccw ${v.midMs}ms linear infinite; transform-origin: ${CX}px ${CY}px; }
        .${rawId}-breathe     { animation: ${rawId}-breathe ${v.breatheMs}ms ease-in-out infinite; transform-origin: ${CX}px ${CY}px; }
        .${rawId}-wave-bar    { animation: ${rawId}-wave 1.1s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
        .${rawId}-orbits      { transition: transform 0.6s ease; transform: ${v.gather ? 'scale(0.86)' : 'scale(1)'}; transform-origin: ${CX}px ${CY}px; }
        @media (prefers-reduced-motion: reduce) {
          .${rawId}-outer-ring, .${rawId}-mid-ring, .${rawId}-breathe, .${rawId}-wave-bar { animation: none !important; }
        }
      `}</style>

      <svg
        width={size} height={size} viewBox="0 0 400 400"
        role="img" aria-hidden="true"
        style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
      >
        <defs>
          <radialGradient id={`${rawId}-field`} cx="42%" cy="38%" r="65%">
            <stop offset="0%" stopColor={AQUA} stopOpacity={v.fieldOpacity * 1.6} />
            <stop offset="55%" stopColor={GOLD} stopOpacity={v.fieldOpacity * 0.5} />
            <stop offset="100%" stopColor={AQUA} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${rawId}-core`} cx="38%" cy="34%" r="70%">
            <stop offset="0%" stopColor="#0f2a33" />
            <stop offset="100%" stopColor="#111113" />
          </radialGradient>
        </defs>

        {/* Faint field around the whole object */}
        <circle cx={CX} cy={CY} r={190} fill={`url(#${rawId}-field)`} />

        <g className={`${rawId}-orbits`}>
          {/* Outer orbit — dotted track, slow clockwise rotation */}
          <g className={reduced ? '' : `${rawId}-outer-ring`}>
            <circle cx={CX} cy={CY} r={R_OUTER} fill="none" stroke={AQUA} strokeOpacity={v.outerOpacity} strokeWidth={1.2} strokeDasharray="1 11" />
          </g>
          {/* Outer particle — independent orbital speed, own layer so it
              doesn't compound with the ring's own rotation. */}
          {!reduced && (
            <circle r={2.6} fill={AQUA} opacity={0.85}>
              <animateMotion dur={`${v.outerParticleMs}ms`} repeatCount="indefinite" path={orbitPath(R_OUTER, true)} rotate="auto" />
            </circle>
          )}

          {/* Middle orbit — champagne/gold track, slow counter-rotation.
              Boosted opacity + a fixed bright node is the 'attention' tell. */}
          <g className={reduced ? '' : `${rawId}-mid-ring`}>
            <circle cx={CX} cy={CY} r={R_MID} fill="none" stroke={GOLD} strokeOpacity={v.midOpacity} strokeWidth={v.attentionBoost ? 1.8 : 1.2} strokeDasharray="1 9" />
            {v.attentionBoost && <circle cx={CX + R_MID} cy={CY} r={4.5} fill={GOLD} />}
          </g>
          {!reduced && (
            <circle r={2.2} fill={GOLD} opacity={0.9}>
              <animateMotion dur={`${v.midParticleMs}ms`} repeatCount="indefinite" path={orbitPath(R_MID, false)} rotate="auto" />
            </circle>
          )}

          {/* Inner energy — breathing, not rotating */}
          <g className={reduced ? '' : `${rawId}-breathe`}>
            <circle cx={CX} cy={CY} r={R_INNER} fill="none" stroke={AQUA} strokeOpacity={0.14} strokeWidth={1} />
          </g>

          {/* Traveling particles — entering/leaving the system. Only in
              working/thinking: idle stays sparse on purpose. */}
          {!reduced && v.travelers && [40, 210].map((angle, i) => {
            const dur = v.outerParticleMs / 2 + i * 1400
            return (
              <circle key={angle} r={2} fill={i === 0 ? AQUA : GOLD}>
                <animateMotion dur={`${dur}ms`} repeatCount="indefinite" begin={`${i * 3.4}s`} path={radialPath(angle)} />
                <animate attributeName="opacity" values="0;0.9;0.9;0" keyTimes="0;0.15;0.75;1" dur={`${dur}ms`} repeatCount="indefinite" begin={`${i * 3.4}s`} />
              </circle>
            )
          })}

          {/* Speaking — restrained radial waveform around the core */}
          {v.waveform && WAVE_ANGLES.map((angle, i) => (
            <g key={angle} transform={`rotate(${angle} ${CX} ${CY})`}>
              <rect
                x={CX - 1.4} y={CY - R_CORE - 20} width={2.8} height={14} rx={1.4}
                fill={GOLD} className={reduced ? '' : `${rawId}-wave-bar`}
                style={{ animationDelay: `${i * 0.09}s` }}
              />
            </g>
          ))}

          {/* Error — restrained accent, not a flashing badge */}
          {v.restrained && (
            <circle cx={CX + R_CORE + 8} cy={CY - R_CORE - 4} r={4} fill={ROSE} opacity={0.85} />
          )}
        </g>

        {/* Core glow */}
        <circle cx={CX} cy={CY} r={R_CORE} fill={`url(#${rawId}-core)`} style={{
          filter: `drop-shadow(0 0 ${Math.round(R_CORE * 0.45)}px ${v.restrained ? ROSE : AQUA}33)`,
        }} />
      </svg>

      {/* The mark itself stays small and centered — a small intelligence
          inside a large field of activity, not the other way around. */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: markSize, height: markSize, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <CayeMark size={markSize} />
      </div>
    </div>
  )
}

export const CayeCore = memo(CayeCoreImpl)
