import { describe, it, expect } from 'vitest'
import { sanitizeDashes } from './sanitize-dashes'

describe('sanitizeDashes', () => {
  it('turns em dashes between clauses into sentence breaks', () => {
    expect(sanitizeDashes('Great choice — the 2-Hour tour is wonderful.'))
      .toBe('Great choice. The 2-Hour tour is wonderful.')
  })

  it('removes en dashes and horizontal bars while preserving normal hyphens', () => {
    const result = sanitizeDashes('Hours 9–11. Status ― ready. A 2-hour tour.')
    expect(result).toBe('Hours 9-11. Status. Ready. A 2-hour tour.')
    expect(result).not.toMatch(/[—–―]/)
    expect(result).toContain('2-hour')
  })

  it('replaces spaced en dashes with a comma', () => {
    expect(sanitizeDashes('Hours: 9 – 11 AM')).toBe('Hours: 9, 11 AM')
  })

  it('avoids duplicate sentence punctuation', () => {
    expect(sanitizeDashes('Really? — yes, absolutely.')).toBe('Really? Yes, absolutely.')
  })

  it('leaves clean messages unchanged', () => {
    expect(sanitizeDashes('no-dash message')).toBe('no-dash message')
  })
})
