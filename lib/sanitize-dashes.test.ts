import { describe, it, expect } from 'vitest'
import { sanitizeDashes } from './sanitize-dashes'

describe('sanitizeDashes', () => {
  it('turns em dashes between clauses into sentence breaks', () => {
    expect(sanitizeDashes('Great choice — the 2-Hour tour is wonderful.'))
      .toBe('Great choice. The 2-Hour tour is wonderful.')
    expect(sanitizeDashes('Adult $190 · Child $150 — group rate'))
      .toBe('Adult $190 · Child $150. Group rate')
  })

  it('turns horizontal bars between clauses into sentence breaks', () => {
    expect(sanitizeDashes('I checked ― the slot is open.'))
      .toBe('I checked. The slot is open.')
  })

  it('preserves numeric ranges with a normal hyphen', () => {
    expect(sanitizeDashes('9–11 AM')).toBe('9-11 AM')
  })

  it('replaces spaced en dashes with a comma', () => {
    expect(sanitizeDashes('Hours: 9 – 11 AM')).toBe('Hours: 9, 11 AM')
  })

  it('leaves normal hyphens alone', () => {
    expect(sanitizeDashes('same-day booking')).toBe('same-day booking')
  })

  it('removes every long-dash variant', () => {
    const result = sanitizeDashes('A — B. C – D. E ― F.')
    expect(result).not.toMatch(/[—–―]/)
  })

  it('handles existing sentence punctuation without double periods', () => {
    expect(sanitizeDashes('Wow! — the tour is great.')).toBe('Wow! The tour is great.')
    expect(sanitizeDashes('Really? — yes, absolutely.')).toBe('Really? Yes, absolutely.')
    expect(sanitizeDashes('Hello. — the tour is great.')).toBe('Hello. The tour is great.')
  })

  it('preserves other Unicode characters', () => {
    expect(sanitizeDashes('Bonjour — we are ready! 🌴☀️'))
      .toBe('Bonjour. We are ready! 🌴☀️')
  })
})
