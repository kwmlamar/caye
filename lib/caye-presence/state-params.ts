// Tunable per-state motion parameters for CayePresence, kept as plain data
// (mirrors the STATE_VISUAL pattern in founder-home/CayeCore.tsx) so the
// numbers can be read, tested, and tweaked without touching the render
// loop or shader code.
//
// To tune: adjust the values below. Nothing else needs to change — the
// render loop (ParticleSphere.tsx) just reads whichever params are
// currently active each frame.

export type CayePresenceState = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface StateParams {
  /** Autonomous Y-axis spin, radians/sec. */
  rotationSpeed: number
  /** Angular speed of the slow X/Z tilt drift. */
  driftSpeed: number
  /** Max tilt from drift, radians. */
  driftAmount: number
  /** Breathing pulse angular frequency. */
  breatheSpeed: number
  /** Breathing pulse amplitude, fraction of base scale. */
  breatheAmount: number
  /** How fast the organic noise field evolves over time. */
  noiseSpeed: number
  /** Base per-particle noise displacement, independent of audio. */
  noiseAmount: number
  /** Baseline uniform scale for this state (e.g. listening contracts slightly). */
  radiusScale: number
  /** How strongly smoothed audio level pushes particles outward radially. */
  audioDisplacementGain: number
  /** How strongly smoothed audio level pumps overall scale. */
  audioScaleGain: number
  /** How strongly smoothed audio level boosts glow/core intensity. */
  audioGlowGain: number
  /** 0 = aqua, 1 = gold — base color warmth for this state. */
  colorWarmth: number
}

export const STATE_PARAMS: Record<CayePresenceState, StateParams> = {
  idle: {
    rotationSpeed: 0.045,
    driftSpeed: 0.15,
    driftAmount: 0.035,
    breatheSpeed: 0.9,
    breatheAmount: 0.025,
    noiseSpeed: 0.12,
    noiseAmount: 0.06,
    radiusScale: 1,
    audioDisplacementGain: 0.05,
    audioScaleGain: 0.02,
    audioGlowGain: 0.15,
    colorWarmth: 0.08,
  },
  listening: {
    rotationSpeed: 0.03,
    driftSpeed: 0.1,
    driftAmount: 0.02,
    breatheSpeed: 1.3,
    breatheAmount: 0.018,
    noiseSpeed: 0.16,
    noiseAmount: 0.045,
    radiusScale: 0.94,
    audioDisplacementGain: 0.16,
    audioScaleGain: 0.05,
    audioGlowGain: 0.35,
    colorWarmth: 0.12,
  },
  thinking: {
    rotationSpeed: 0.09,
    driftSpeed: 0.22,
    driftAmount: 0.05,
    breatheSpeed: 1.6,
    breatheAmount: 0.03,
    noiseSpeed: 0.55,
    noiseAmount: 0.12,
    radiusScale: 1,
    audioDisplacementGain: 0.05,
    audioScaleGain: 0.02,
    audioGlowGain: 0.25,
    colorWarmth: 0.35,
  },
  speaking: {
    rotationSpeed: 0.05,
    driftSpeed: 0.18,
    driftAmount: 0.04,
    breatheSpeed: 1.1,
    breatheAmount: 0.02,
    noiseSpeed: 0.3,
    noiseAmount: 0.07,
    radiusScale: 1,
    // Speaking sensitivity: raise these three to make Caye react bigger to
    // the same audio level (or lower them if speech makes it look frantic).
    audioDisplacementGain: 0.55,
    audioScaleGain: 0.14,
    audioGlowGain: 0.9,
    colorWarmth: 0.55,
  },
}

/** How fast the live (in-use) params chase the target state's params when
 *  `state` changes — this is what makes "speaking → idle" ease out instead
 *  of snapping. Higher = snappier transition. */
export const STATE_TRANSITION_RATE_PER_SEC = 2.2

export function getStateParams(state: CayePresenceState): StateParams {
  return STATE_PARAMS[state]
}

/** Component-wise lerp between two param sets, `t` clamped to 0..1. Used
 *  every frame to ease the live params toward whatever state is current. */
export function lerpStateParams(from: StateParams, to: StateParams, t: number): StateParams {
  const clamped = Math.min(1, Math.max(0, t))
  const lerp = (a: number, b: number) => a + (b - a) * clamped
  return {
    rotationSpeed: lerp(from.rotationSpeed, to.rotationSpeed),
    driftSpeed: lerp(from.driftSpeed, to.driftSpeed),
    driftAmount: lerp(from.driftAmount, to.driftAmount),
    breatheSpeed: lerp(from.breatheSpeed, to.breatheSpeed),
    breatheAmount: lerp(from.breatheAmount, to.breatheAmount),
    noiseSpeed: lerp(from.noiseSpeed, to.noiseSpeed),
    noiseAmount: lerp(from.noiseAmount, to.noiseAmount),
    radiusScale: lerp(from.radiusScale, to.radiusScale),
    audioDisplacementGain: lerp(from.audioDisplacementGain, to.audioDisplacementGain),
    audioScaleGain: lerp(from.audioScaleGain, to.audioScaleGain),
    audioGlowGain: lerp(from.audioGlowGain, to.audioGlowGain),
    colorWarmth: lerp(from.colorWarmth, to.colorWarmth),
  }
}

/** Exponential-rate step size for a given dt — shared helper so
 *  ParticleSphere's per-frame lerp uses the same curve as the state
 *  transition rate constant above. */
export function transitionStep(dtSeconds: number, ratePerSec = STATE_TRANSITION_RATE_PER_SEC): number {
  return 1 - Math.exp(-ratePerSec * Math.max(dtSeconds, 0))
}
