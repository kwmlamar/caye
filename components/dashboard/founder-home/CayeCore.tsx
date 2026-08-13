'use client'

import { useId, memo } from 'react'
import { CayeMark } from '@/components/brand/CayeMark'
import { useMediaQuery } from '@/lib/useMediaQuery'

/**
 * Caye's visual presence — a small intelligence at the center of a field
 * of orbital activity, not a status badge. Generalized so the same
 * component can eventually live anywhere in the product.
 *
 * 2026-08-13 quality pass: pushed from "logo with circles around it"
 * toward "intelligence with an energy field" — elliptical, tilted orbits
 * instead of perfect concentric circles, a third barely-visible
 * incomplete arc for depth, particles at varied size/brightness (some on
 * rings, one on its own irregular loop), and one particle whose color
 * drifts between aqua and champagne rather than staying fixed — the
 * "relationship between the two energies" made literal on a single
 * traveler instead of a connector line.
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

// Elliptical, tilted — perfect concentric circles are what read as "logo
// with circles around it." Radii and tilts are hand-picked, not derived,
// so the three rings don't look like a formula.
const OUTER = { rx: 168, ry: 142, tilt: -9 }
const MID = { rx: 122, ry: 100, tilt: 14 }
const FAR = { rx: 195, ry: 179, tilt: 5 } // barely-visible, incomplete arc — depth, not a track
const R_OUTER_AVG = (OUTER.rx + OUTER.ry) / 2
const R_INNER = 74
const R_CORE = 42

function ellipsePath(rx: number, ry: number, clockwise: boolean): string {
  const sweep = clockwise ? 1 : 0
  return `M ${CX + rx},${CY} A ${rx},${ry} 0 1,${sweep} ${CX - rx},${CY} A ${rx},${ry} 0 1,${sweep} ${CX + rx},${CY}`
}

// An open arc, not a closed ring — "some orbital paths should be
// incomplete." sweepDeg < 360 so the far track visibly has a gap.
function partialArcPath(rx: number, ry: number, startDeg: number, sweepDeg: number): string {
  const toRad = (d: number) => (d * Math.PI) / 180
  const sx = CX + rx * Math.cos(toRad(startDeg))
  const sy = CY + ry * Math.sin(toRad(startDeg))
  const endDeg = startDeg + sweepDeg
  const ex = CX + rx * Math.cos(toRad(endDeg))
  const ey = CY + ry * Math.sin(toRad(endDeg))
  const largeArc = sweepDeg > 180 ? 1 : 0
  return `M ${sx},${sy} A ${rx},${ry} 0 ${largeArc},1 ${ex},${ey}`
}

// A closed but irregular loop (hand-built from cubic beziers, not an
// ellipse formula) — the one particle meant to read as moving on its
// own, not riding a track like everything else.
function wobblePath(rx: number, ry: number): string {
  return `M ${CX + rx},${CY}
    C ${CX + rx},${CY + ry * 0.72} ${CX + rx * 0.48},${CY + ry * 1.18} ${CX},${CY + ry * 0.88}
    C ${CX - rx * 0.58},${CY + ry * 0.58} ${CX - rx * 1.04},${CY - ry * 0.28} ${CX - rx * 0.8},${CY - ry}
    C ${CX - rx * 0.3},${CY - ry * 1.22} ${CX + rx * 0.6},${CY - ry * 0.92} ${CX + rx},${CY} Z`
}

// A straight radial line at `angleDeg` from the outer track down to the
// core — used for the "particle entering/leaving the system" traveler.
function radialPath(angleDeg: number): string {
  const rad = (angleDeg * Math.PI) / 180
  const ox = CX + R_OUTER_AVG * Math.cos(rad)
  const oy = CY + R_OUTER_AVG * Math.sin(rad)
  const ix = CX + R_CORE * Math.cos(rad)
  const iy = CY + R_CORE * Math.sin(rad)
  return `M ${ox},${oy} L ${ix},${iy}`
}

interface StateVisual {
  outerMs: number; midMs: number; farMs: number
  outerParticleMs: number; midParticleMs: number; wobbleMs: number
  breatheMs: number; breatheScale: [number, number]
  outerOpacity: number; midOpacity: number; fieldOpacity: number
  travelers: boolean; waveform: boolean; gather: boolean; attentionBoost: boolean; restrained: boolean
}

const STATE_VISUAL: Record<CayeState, StateVisual> = {
  idle: {
    outerMs: 92000, midMs: 71000, farMs: 150000, outerParticleMs: 17000, midParticleMs: 13000, wobbleMs: 31000,
    breatheMs: 4200, breatheScale: [0.97, 1.02],
    outerOpacity: 0.21, midOpacity: 0.15, fieldOpacity: 0.06,
    travelers: false, waveform: false, gather: false, attentionBoost: false, restrained: false,
  },
  working: {
    outerMs: 47000, midMs: 35000, farMs: 90000, outerParticleMs: 9500, midParticleMs: 7200, wobbleMs: 16000,
    breatheMs: 2600, breatheScale: [0.96, 1.05],
    outerOpacity: 0.31, midOpacity: 0.23, fieldOpacity: 0.09,
    travelers: true, waveform: false, gather: false, attentionBoost: false, restrained: false,
  },
  thinking: {
    outerMs: 31000, midMs: 23000, farMs: 62000, outerParticleMs: 6200, midParticleMs: 4700, wobbleMs: 10000,
    breatheMs: 1800, breatheScale: [0.94, 1.03],
    outerOpacity: 0.29, midOpacity: 0.27, fieldOpacity: 0.11,
    travelers: true, waveform: false, gather: true, attentionBoost: false, restrained: false,
  },
  speaking: {
    outerMs: 41000, midMs: 31000, farMs: 84000, outerParticleMs: 8200, midParticleMs: 6100, wobbleMs: 14000,
    breatheMs: 1500, breatheScale: [0.97, 1.03],
    outerOpacity: 0.29, midOpacity: 0.31, fieldOpacity: 0.1,
    travelers: false, waveform: true, gather: false, attentionBoost: false, restrained: false,
  },
  attention: {
    outerMs: 51000, midMs: 27000, farMs: 96000, outerParticleMs: 10200, midParticleMs: 5300, wobbleMs: 19000,
    breatheMs: 2400, breatheScale: [0.97, 1.03],
    outerOpacity: 0.25, midOpacity: 0.38, fieldOpacity: 0.1,
    travelers: false, waveform: false, gather: false, attentionBoost: true, restrained: false,
  },
  error: {
    outerMs: 112000, midMs: 91000, farMs: 180000, outerParticleMs: 21000, midParticleMs: 17000, wobbleMs: 40000,
    breatheMs: 5200, breatheScale: [0.98, 1.01],
    outerOpacity: 0.13, midOpacity: 0.11, fieldOpacity: 0.05,
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
        .${rawId}-far-ring    { animation: ${rawId}-spin-cw ${v.farMs}ms linear infinite; transform-origin: ${CX}px ${CY}px; }
        .${rawId}-breathe     { animation: ${rawId}-breathe ${v.breatheMs}ms ease-in-out infinite; transform-origin: ${CX}px ${CY}px; }
        .${rawId}-wave-bar    { animation: ${rawId}-wave 1.1s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
        .${rawId}-orbits      { transition: transform 0.6s ease; transform: ${v.gather ? 'scale(0.86)' : 'scale(1)'}; transform-origin: ${CX}px ${CY}px; }
        @media (prefers-reduced-motion: reduce) {
          .${rawId}-outer-ring, .${rawId}-mid-ring, .${rawId}-far-ring, .${rawId}-breathe, .${rawId}-wave-bar { animation: none !important; }
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
          <filter id={`${rawId}-soft`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.1" />
          </filter>
        </defs>

        {/* Faint field around the whole object */}
        <circle cx={CX} cy={CY} r={196} fill={`url(#${rawId}-field)`} />

        <g className={`${rawId}-orbits`}>
          {/* Far track — largest, softest, incomplete. Pure depth cue;
              nothing travels on it. */}
          <g className={reduced ? '' : `${rawId}-far-ring`}>
            <g transform={`rotate(${FAR.tilt} ${CX} ${CY})`}>
              <path
                d={partialArcPath(FAR.rx, FAR.ry, 24, 224)}
                fill="none" stroke={AQUA} strokeOpacity={v.outerOpacity * 0.32} strokeWidth={1}
                filter={`url(#${rawId}-soft)`}
              />
            </g>
          </g>

          {/* Outer orbit — aqua, elliptical, tilted, slow clockwise drift.
              Particles live in a separate (tilted but non-spinning) layer
              so the ring's own rotation and a particle's travel along it
              don't cancel out — two independent speeds, not one. */}
          <g className={reduced ? '' : `${rawId}-outer-ring`}>
            <g transform={`rotate(${OUTER.tilt} ${CX} ${CY})`}>
              <ellipse cx={CX} cy={CY} rx={OUTER.rx} ry={OUTER.ry} fill="none" stroke={AQUA} strokeOpacity={v.outerOpacity} strokeWidth={1.2} strokeDasharray="1 12" />
            </g>
          </g>
          {!reduced && (
            <g transform={`rotate(${OUTER.tilt} ${CX} ${CY})`}>
              <circle r={2.7} fill={AQUA} opacity={0.9}>
                <animateMotion dur={`${v.outerParticleMs}ms`} repeatCount="indefinite" path={ellipsePath(OUTER.rx, OUTER.ry, true)} rotate="auto" />
              </circle>
              <circle r={1.5} fill={AQUA} opacity={0.42}>
                <animateMotion dur={`${v.outerParticleMs * 1.6}ms`} repeatCount="indefinite" begin="-4s" path={ellipsePath(OUTER.rx, OUTER.ry, true)} rotate="auto" />
              </circle>
            </g>
          )}

          {/* Middle orbit — champagne/gold, tilted the other way,
              counter-rotating. Boosted opacity + a fixed bright node is
              the 'attention' tell. */}
          <g className={reduced ? '' : `${rawId}-mid-ring`}>
            <g transform={`rotate(${MID.tilt} ${CX} ${CY})`}>
              <ellipse cx={CX} cy={CY} rx={MID.rx} ry={MID.ry} fill="none" stroke={GOLD} strokeOpacity={v.midOpacity} strokeWidth={v.attentionBoost ? 1.8 : 1.2} strokeDasharray="1 10" />
              {v.attentionBoost && <circle cx={CX + MID.rx} cy={CY} r={4.5} fill={GOLD} />}
            </g>
          </g>
          {!reduced && (
            <g transform={`rotate(${MID.tilt} ${CX} ${CY})`}>
              <circle r={2.3} fill={GOLD} opacity={0.85}>
                <animateMotion dur={`${v.midParticleMs}ms`} repeatCount="indefinite" path={ellipsePath(MID.rx, MID.ry, false)} rotate="auto" />
              </circle>
              {/* The one particle whose color itself drifts between aqua
                  and champagne — the "relationship between the two
                  energies" made literal, without a connector line. */}
              <circle r={2}>
                <animateMotion dur={`${v.midParticleMs * 1.35}ms`} repeatCount="indefinite" begin="-2.5s" path={ellipsePath(MID.rx, MID.ry, false)} />
                <animate attributeName="fill" values={`${AQUA};${GOLD};${AQUA}`} dur={`${v.midParticleMs * 1.35}ms`} repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.4;0.85;0.4" dur={`${v.midParticleMs * 1.35}ms`} repeatCount="indefinite" />
              </circle>
            </g>
          )}

          {/* One particle on its own irregular loop, not a ring — reads
              as independent rather than tracked. */}
          {!reduced && (
            <circle r={1.7} fill={GOLD} opacity={0.5}>
              <animateMotion dur={`${v.wobbleMs}ms`} repeatCount="indefinite" path={wobblePath(R_INNER + 14, R_INNER + 6)} rotate="auto" />
            </circle>
          )}

          {/* Inner energy — breathing, not rotating */}
          <g className={reduced ? '' : `${rawId}-breathe`}>
            <circle cx={CX} cy={CY} r={R_INNER} fill="none" stroke={AQUA} strokeOpacity={0.13} strokeWidth={1} />
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

      {/* The mark itself stays small and perfectly centered — a small
          intelligence inside a large field of activity, not the other
          way around. */}
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
