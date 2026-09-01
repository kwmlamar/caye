import { describe, expect, it } from 'vitest'
import { messageFor } from './founder-investigation-updates'

describe('founder investigation update voice', () => {
  it('does not claim incomplete research is finished and surfaces missing deliverables', () => {
    const message = messageFor('initial_answer', 'Which 15 competitors have prices, booking flows, policies, segments, and gaps?', {
      brief: 'Current evidence identifies a competitive landscape composed of local operators. Published prices vary widely. Booking and cancellation rules are incompletely documented in the supplied evidence. A fourth sentence should still fit. A fifth sentence should be dropped.',
      claims: [{ confidence: 0.8 }],
      unknowns: ['Cancellation policies are still missing for several competitors.', 'Only 9 of the requested 15 competitors have evidence-backed pricing.'],
      recommendations: ['Compare the strongest three offers side by side.', 'Verify cancellation policies next.', 'This third recommendation should be omitted.'],
    })

    expect(message).toContain('I made progress on the research. Here is what is solid so far:')
    expect(message).not.toContain('I finished the research')
    expect(message).toContain('I found a mix of local operators.')
    expect(message).toContain('not fully published in the sources I checked')
    expect(message).toContain('Still unresolved:')
    expect(message).toContain('Only 9 of the requested 15 competitors')
    expect(message).toContain('What I would do next:')
    expect(message).not.toContain('Which 15 competitors')
    expect(message).not.toContain('This third recommendation')
    expect(message).not.toContain('A fifth sentence')
    expect(message).not.toMatch(/[—–]/)
  })

  it('uses finished wording only when synthesis has no unknowns or conflicts', () => {
    const message = messageFor('initial_answer', 'Research the market', {
      brief: 'The requested market evidence is complete.',
      claims: [{ confidence: 0.9 }],
      unknowns: [],
      conflictingEvidence: [],
    })
    expect(message).toContain('I finished the research. Here is the short version:')
  })
})
