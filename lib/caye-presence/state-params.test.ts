import { describe, expect, it } from 'vitest'
import { getStateParams, lerpStateParams, transitionStep, STATE_PARAMS } from './state-params'

describe('getStateParams', () => {
  it('returns the matching params for every state', () => {
    for (const state of Object.keys(STATE_PARAMS) as (keyof typeof STATE_PARAMS)[]) {
      expect(getStateParams(state)).toBe(STATE_PARAMS[state])
    }
  })

  it('gives speaking the strongest audio response of any state', () => {
    const speaking = getStateParams('speaking')
    for (const state of ['idle', 'listening', 'thinking'] as const) {
      const other = getStateParams(state)
      expect(speaking.audioDisplacementGain).toBeGreaterThan(other.audioDisplacementGain)
      expect(speaking.audioGlowGain).toBeGreaterThan(other.audioGlowGain)
    }
  })

  it('has listening contract slightly relative to idle', () => {
    expect(getStateParams('listening').radiusScale).toBeLessThan(getStateParams('idle').radiusScale)
  })
})

describe('lerpStateParams', () => {
  it('returns "from" at t=0 and "to" at t=1', () => {
    const from = getStateParams('idle')
    const to = getStateParams('speaking')
    expect(lerpStateParams(from, to, 0)).toEqual(from)
    expect(lerpStateParams(from, to, 1)).toEqual(to)
  })

  it('clamps t outside 0..1', () => {
    const from = getStateParams('idle')
    const to = getStateParams('speaking')
    expect(lerpStateParams(from, to, -5)).toEqual(from)
    expect(lerpStateParams(from, to, 5)).toEqual(to)
  })

  it('interpolates midpoint values', () => {
    const from = getStateParams('idle')
    const to = getStateParams('speaking')
    const mid = lerpStateParams(from, to, 0.5)
    expect(mid.audioDisplacementGain).toBeCloseTo(
      (from.audioDisplacementGain + to.audioDisplacementGain) / 2,
      10
    )
  })
})

describe('transitionStep', () => {
  it('is 0 at dt=0', () => {
    expect(transitionStep(0)).toBe(0)
  })

  it('approaches 1 for a large dt', () => {
    expect(transitionStep(10)).toBeGreaterThan(0.999)
  })

  it('is monotonic in dt', () => {
    expect(transitionStep(0.5)).toBeGreaterThan(transitionStep(0.1))
  })
})
