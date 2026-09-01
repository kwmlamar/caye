import { describe, expect, it } from 'vitest'
import { messageFor } from './founder-investigation-updates'

describe('founder investigation update voice', () => {
  it('does not repeat the full research question and keeps the update concise', () => {
    const message = messageFor('initial_answer', 'Which 15 competitors have prices, booking flows, policies, segments, and gaps?', {
      brief: 'Current evidence identifies a competitive landscape composed of local operators. Published prices vary widely. Booking and cancellation rules are incompletely documented in the supplied evidence. A fourth sentence should still fit. A fifth sentence should be dropped.',
      claims: [{ confidence: 0.8 }],
      recommendations: ['Compare the strongest three offers side by side.', 'Verify cancellation policies next.', 'This third recommendation should be omitted.'],
    })

    expect(message).toContain('I finished the research. Here is the short version:')
    expect(message).toContain('I found a mix of local operators.')
    expect(message).toContain('not fully published in the sources I checked')
    expect(message).toContain('What I would do next:')
    expect(message).not.toContain('Which 15 competitors')
    expect(message).not.toContain('This third recommendation')
    expect(message).not.toContain('A fifth sentence')
    expect(message).not.toMatch(/[—–]/)
  })
})
