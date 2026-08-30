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
    'Draft a reply to Juli King about her booking.',
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
    'Hey Caye, what\'s up?',
    'Hey Key, what\'s up?',
    'Hey Kay, what\'s up?',
    'Key, how are you?',
    'Can you hear me?',
    'Okay, thank you.',
  ]

  for (const text of mustSkip) {
    it(`does not require grounding: "${text}"`, () => {
      expect(requiresBusinessGrounding(text)).toBe(false)
    })
  }
})

describe('requiresBusinessGrounding — edge cases', () => {
  it('empty/whitespace-only text does not require grounding', () => {
    expect(requiresBusinessGrounding('')).toBe(false)
    expect(requiresBusinessGrounding('   ')).toBe(false)
  })

  it('a transform verb with a quoted customer message containing its own question mark is still skip-eligible', () => {
    expect(requiresBusinessGrounding('Draft a friendly reply to this customer message: "Can I bring my dog?"')).toBe(false)
  })

  it('a bare transform verb with no inline-content reference still requires grounding', () => {
    expect(requiresBusinessGrounding('Draft a reply.')).toBe(true)
  })
})
