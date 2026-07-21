import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { composeFollowupPingSummary } from '@/lib/whatsapp/escalation-followup'

describe('composeFollowupPingSummary', () => {
  it('uses the stored clean ping_summary, not internal_context jargon', () => {
    const result = composeFollowupPingSummary({
      ping_summary: 'B2B inquiry — "wholesale rates for our tour groups"',
      category: 'sensitive',
    })
    expect(result).toBe('Still waiting — B2B inquiry — "wholesale rates for our tour groups"')
    expect(result).not.toMatch(/forced escalation/i)
    expect(result).not.toMatch(/inbound classifier/i)
    expect(result).not.toMatch(/b2b_partnership/i)
  })

  it('falls back to the category label for legacy rows with no ping_summary', () => {
    const result = composeFollowupPingSummary({ ping_summary: null, category: 'policy' })
    expect(result).toBe('Still waiting — A call I need you to make')
    expect(result).not.toMatch(/forced escalation/i)
    expect(result).not.toMatch(/inbound classifier/i)
  })
})
