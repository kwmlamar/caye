import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { requiresBusinessGrounding } from './business-grounding-classifier'

describe('requiresBusinessGrounding — must require grounding (fail closed)', () => {
  const mustGround = [
    'Who is Juli King?',
    'What is her email?',
    'Did she pay?',
    'What happened with her booking?',
    'Show me her recent messages.',
    'Who still owes us money?',
    'What bookings do we have tomorrow?',
    'How much revenue did we make this week?',
    'What happened with Sarah?',
    'Look up the customer named Juli King. If we have a match, also tell me about her recent booking and message history with us.',
    'Draft a reply to Juli King about her booking.', // starts with a transform verb but references an external lookup, not inline content
  ]

  for (const text of mustGround) {
    it(`requires grounding: "${text}"`, () => {
      expect(requiresBusinessGrounding(text)).toBe(true)
    })
  }
})

describe('requiresBusinessGrounding — must be allowed to skip grounding', () => {
  const mustSkip = [
    'What can you do?',
    'Explain how your booking workflow works.',
    'Draft a friendly reply to this customer message: "Do you have availability next week?"',
    'Rewrite this sentence.',
    'Please rewrite this: "we are closed on sundays"',
  ]

  for (const text of mustSkip) {
    it(`does not require grounding: "${text}"`, () => {
      expect(requiresBusinessGrounding(text)).toBe(false)
    })
  }
})

describe('requiresBusinessGrounding — edge cases', () => {
  it('defaults to requiring grounding for empty/whitespace-only text is false (nothing to ground)', () => {
    expect(requiresBusinessGrounding('')).toBe(false)
    expect(requiresBusinessGrounding('   ')).toBe(false)
  })

  it('a transform verb with a quoted customer message containing its own question mark is still skip-eligible', () => {
    // The classifier must not be confused by punctuation inside pasted content.
    expect(requiresBusinessGrounding('Draft a friendly reply to this customer message: "Can I bring my dog?"')).toBe(false)
  })

  it('a bare transform verb with no inline-content reference still requires grounding (ambiguous — fail closed)', () => {
    expect(requiresBusinessGrounding('Draft a reply.')).toBe(true)
  })
})
