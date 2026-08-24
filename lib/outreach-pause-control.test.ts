import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))

import { classifyOutreachPause } from './outreach-pause-control'

describe('outreach pause provenance', () => {
  it('allows an owner-created pause to be recovered', () => {
    expect(classifyOutreachPause({ paused: true, source: 'owner_manual' }).disposition).toBe('owner_resumable')
  })

  it('never lets owner recovery override the bounce safety stop', () => {
    expect(classifyOutreachPause({ paused: true, source: 'bounce_kill_switch' }).disposition).toBe('safety_locked')
  })

  it('keeps legacy pauses blocked when their source is not provable', () => {
    expect(classifyOutreachPause({ paused: true }).disposition).toBe('unknown_blocked')
  })
})
