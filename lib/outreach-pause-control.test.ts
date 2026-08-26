import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))

import { classifyOutreachPause } from './outreach-pause-control'

describe('outreach pause provenance', () => {
  it('allows an owner-created pause to be recovered', () => {
    expect(classifyOutreachPause({ paused: true, source: 'owner_manual' }).disposition).toBe('owner_resumable')
  })

  it('never lets owner recovery override the bounce safety stop', () => {
    expect(classifyOutreachPause({ paused: true, source: 'bounce_safety', activeSafetyCondition: 'bounce_threshold' }).disposition).toBe('safety_active')
  })

  it('does not let an owner-manual provenance mask a current safety stop', () => {
    expect(classifyOutreachPause({ paused: true, source: 'owner_manual', activeSafetyCondition: 'bounce_threshold' }).disposition).toBe('safety_active')
  })

  it('does not turn a historical safety stop into an owner override after the immediate threshold clears', () => {
    expect(classifyOutreachPause({ paused: true, source: 'bounce_safety' }).disposition).toBe('safety_recovery_not_supported')
  })

  it('keeps legacy pauses blocked when their source is not provable', () => {
    expect(classifyOutreachPause({ paused: true }).disposition).toBe('unknown_blocked')
  })
})
