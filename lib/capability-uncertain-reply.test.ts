import { describe, expect, it } from 'vitest'
import {
  capabilityUncertainReplyFor,
  TRANSPORT_CAPABILITY_REPLY,
} from './capability-uncertain-reply'

describe('capabilityUncertainReplyFor', () => {
  it('qualifies an airport-transport request without promising availability', () => {
    const reply = capabilityUncertainReplyFor(
      'I need transportation from the airport to my vacation accommodation.',
      'Tour Booking: Transportation / VIP Service'
    )

    expect(reply).toBe(TRANSPORT_CAPABILITY_REPLY)
    expect(reply).toContain('whether you\'ll be arriving by ferry or plane')
    expect(reply).not.toMatch(/we(?:'d| would) be happy to help|we offer|we can arrange/i)
  })

  it('does not override unrelated holds', () => {
    expect(capabilityUncertainReplyFor('I need a refund for my tour.')).toBeUndefined()
  })
})
