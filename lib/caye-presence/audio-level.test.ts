import { describe, expect, it } from 'vitest'
import { computeLevel, smoothLevel } from './audio-level'

describe('computeLevel', () => {
  it('returns 0 for silence', () => {
    expect(computeLevel(new Uint8Array([0, 0, 0, 0]))).toBe(0)
  })

  it('returns 1 for full-scale bytes', () => {
    expect(computeLevel(new Uint8Array([255, 255, 255]))).toBeCloseTo(1, 5)
  })

  it('returns 0 for an empty array instead of NaN', () => {
    expect(computeLevel(new Uint8Array([]))).toBe(0)
  })

  it('weights loud peaks more than a plain average would', () => {
    const peaky = computeLevel(new Uint8Array([255, 0, 0, 0]))
    const flat = computeLevel(new Uint8Array([64, 64, 64, 64]))
    // RMS of one full-scale byte among silence (0.5) is louder than a
    // uniform 64/255 (~0.25) — confirms this isn't a simple mean.
    expect(peaky).toBeGreaterThan(flat)
  })
})

describe('smoothLevel', () => {
  it('rises toward a higher target', () => {
    const next = smoothLevel(0, 1, 1 / 60)
    expect(next).toBeGreaterThan(0)
    expect(next).toBeLessThan(1)
  })

  it('falls toward a lower target', () => {
    const next = smoothLevel(1, 0, 1 / 60)
    expect(next).toBeLessThan(1)
    expect(next).toBeGreaterThan(0)
  })

  it('attacks faster than it releases by default', () => {
    const dt = 1 / 60
    const attackStep = smoothLevel(0, 1, dt) - 0
    const releaseStep = 1 - smoothLevel(1, 0, dt)
    expect(attackStep).toBeGreaterThan(releaseStep)
  })

  it('converges to the target over many steps', () => {
    let level = 0
    for (let i = 0; i < 240; i++) level = smoothLevel(level, 1, 1 / 60)
    expect(level).toBeCloseTo(1, 2)
  })

  it('is a no-op at dt=0', () => {
    expect(smoothLevel(0.3, 0.9, 0)).toBe(0.3)
  })
})
