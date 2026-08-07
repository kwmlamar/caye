import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { detectInternalLeak, stripToolMarkers } from './operator-text-guard'
import { detectForcedEscalation } from './forced-escalation'

// The two strings that actually reached Mrs. Max's Caye Direct thread on
// 2026-08-07. Kept verbatim so these tests fail if either leak returns.
const LEAKED_TURN = "You're welcome! Anytime. [tool_use: get_held_queue]"

describe('stripToolMarkers', () => {
  it('removes a marker from a mixed text + tool_use turn', () => {
    expect(stripToolMarkers(LEAKED_TURN)).toBe("You're welcome! Anytime.")
  })

  it('returns empty for a turn that is nothing but markers', () => {
    expect(stripToolMarkers('[tool_use: get_customer_history]')).toBe('')
    expect(stripToolMarkers('[tool_result] [tool_result]')).toBe('')
  })

  it('leaves ordinary prose untouched', () => {
    const clean = 'Two things worth flagging from the scan: Ruslan followed up again.'
    expect(stripToolMarkers(clean)).toBe(clean)
  })
})

describe('detectInternalLeak', () => {
  it('flags a raw tool marker', () => {
    expect(detectInternalLeak(LEAKED_TURN)).toMatch(/tool marker/)
  })

  it('flags the forced-escalation internalContext verbatim', () => {
    // Built through the real producer rather than a hand-copied string, so
    // this test tracks forced-escalation.ts if its wording changes.
    const forced = detectForcedEscalation('Partnership enquiry.', 'b2b_partnership')
    expect(forced).not.toBeNull()
    expect(detectInternalLeak(forced!.internalContext)).not.toBeNull()
  })

  it('passes clean operator prose, including prose that mentions escalating', () => {
    expect(detectInternalLeak('')).toBeNull()
    expect(
      detectInternalLeak(
        "B2B enquiry — needs your call. I escalated this to you rather than answering it myself."
      )
    ).toBeNull()
    expect(
      detectInternalLeak('Ruslan Prakapovich wrote: "Dear Karenda, Maxwell and Team…"')
    ).toBeNull()
  })
})
