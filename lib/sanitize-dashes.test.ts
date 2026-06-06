import { describe, it, expect } from 'vitest'
import { sanitizeDashes } from './sanitize-dashes'

describe('sanitizeDashes', () => {
  it('correctly transforms em-dashes between clauses into a sentence break (Rule 1)', () => {
    const input1 = 'Great choice — the 2-Hour tour is wonderful.'
    const expected1 = 'Great choice. The 2-Hour tour is wonderful.'
    expect(sanitizeDashes(input1)).toBe(expected1)

    const input2 = 'Adult $190 · Child $150 — group rate'
    const expected2 = 'Adult $190 · Child $150. Group rate'
    expect(sanitizeDashes(input2)).toBe(expected2)
  })

  it('preserves numeric ranges using en-dashes by falling through to Rule 4', () => {
    const input = '9–11 AM'
    const expected = '9-11 AM'
    expect(sanitizeDashes(input)).toBe(expected)
  })

  it('replaces en-dashes surrounded by spaces with a comma (Rule 2)', () => {
    const input = 'Hours: 9 – 11 AM'
    const expected = 'Hours: 9, 11 AM'
    expect(sanitizeDashes(input)).toBe(expected)
  })

  it('leaves already-clean messages unchanged', () => {
    const input = 'no-dash message'
    expect(sanitizeDashes(input)).toBe(input)
  })

  it('handles preceding sentence-ending punctuation gracefully without double periods (Rule 1 edge case)', () => {
    const input1 = 'Wow! — the tour is great.'
    const expected1 = 'Wow! The tour is great.'
    expect(sanitizeDashes(input1)).toBe(expected1)

    const input2 = 'Really? — yes, absolutely.'
    const expected2 = 'Really? Yes, absolutely.'
    expect(sanitizeDashes(input2)).toBe(expected2)

    const input3 = 'Hello. — the tour is great.'
    const expected3 = 'Hello. The tour is great.'
    expect(sanitizeDashes(input3)).toBe(expected3)
  })

  it('preserves other Unicode characters like emojis and accented characters', () => {
    const input = 'Bonjour — we are ready! 🌴☀️'
    const expected = 'Bonjour. We are ready! 🌴☀️'
    expect(sanitizeDashes(input)).toBe(expected)
  })

  it('collapses multiple periods and leading space/comma residue', () => {
    const input = 'Okay.. , yes, we can do that.'
    const expected = 'Okay., yes, we can do that.'
    expect(sanitizeDashes(input)).toBe(expected)
  })
})
