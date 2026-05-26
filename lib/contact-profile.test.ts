import { describe, it, expect } from 'vitest'
import { shouldExtractContactProfile } from './contact-profile-trigger'

describe('shouldExtractContactProfile', () => {
  it('fires on the 3rd inbound message (first extraction)', () => {
    expect(shouldExtractContactProfile(3)).toBe(true)
  })

  it('does not fire before the 3rd message', () => {
    expect(shouldExtractContactProfile(0)).toBe(false)
    expect(shouldExtractContactProfile(1)).toBe(false)
    expect(shouldExtractContactProfile(2)).toBe(false)
  })

  it('refreshes every 5 messages after the first extraction', () => {
    // First extraction at 3, then every 5 thereafter: 8, 13, 18, 23...
    expect(shouldExtractContactProfile(8)).toBe(true)
    expect(shouldExtractContactProfile(13)).toBe(true)
    expect(shouldExtractContactProfile(18)).toBe(true)
  })

  it('does not fire between refresh points', () => {
    // Quiet zone after the first extraction (4, 5, 6, 7) and after each
    // refresh (9, 10, 11, 12) — no extraction should run.
    for (const n of [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17]) {
      expect(shouldExtractContactProfile(n), `count=${n}`).toBe(false)
    }
  })
})
