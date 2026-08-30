import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { normalizeSpokenPunctuation } from './spoken-text'
import { requiresBusinessGrounding } from '@/lib/model-router/tool-bridge/business-grounding-classifier'

describe('normalizeSpokenPunctuation', () => {
  it('folds the typographic apostrophe transcription models actually emit', () => {
    expect(normalizeSpokenPunctuation('what’s up')).toBe("what's up")
  })

  it('folds curly double quotes, dashes and ellipses', () => {
    expect(normalizeSpokenPunctuation('“ok” — fine…')).toBe('"ok" - fine...')
  })

  it('folds non-breaking and exotic spaces to a plain space', () => {
    expect(normalizeSpokenPunctuation('hey\u00a0caye\u2009there')).toBe('hey caye there')
  })

  it('leaves ASCII untouched and is idempotent', () => {
    const ascii = "Hey Caye, what's up? - checking \"now\"..."
    expect(normalizeSpokenPunctuation(ascii)).toBe(ascii)
    expect(normalizeSpokenPunctuation(normalizeSpokenPunctuation('what’s'))).toBe("what's")
  })

  it('does not change the length semantics of a business question', () => {
    expect(normalizeSpokenPunctuation('What bookings do we have tomorrow?')).toBe(
      'What bookings do we have tomorrow?'
    )
  })
})

/**
 * The regression this whole module exists for. Both spellings of the same
 * spoken sentence must route identically — before the fix, the curly form
 * required grounding, which forbade a plain-text answer until a tool had
 * run, turning "I'm here" into a full control-plane round trip.
 */
describe('grounding is insensitive to how the transcript spells an apostrophe', () => {
  it.each([
    ["Hey Caye, what's up?", 'Hey Caye, what’s up?'],
    ["What's up?", 'What’s up?'],
    ["Can you hear me? Thanks, that's it.", 'Can you hear me? Thanks, that’s it.'],
  ])('treats %s and %s the same', (ascii, curly) => {
    expect(requiresBusinessGrounding(curly)).toBe(requiresBusinessGrounding(ascii))
  })

  it('still exempts the curly greeting from grounding', () => {
    expect(requiresBusinessGrounding('Hey Caye, what’s up?')).toBe(false)
  })

  it('exempts a chained pleasantry, which speech produces constantly', () => {
    expect(requiresBusinessGrounding('Okay, thank you.')).toBe(false)
    expect(requiresBusinessGrounding('Cool, thanks')).toBe(false)
  })

  it('still requires grounding for real business questions, curly or not', () => {
    expect(requiresBusinessGrounding('What’s Bimini looking like today?')).toBe(true)
    expect(requiresBusinessGrounding("What's Bimini looking like today?")).toBe(true)
    expect(requiresBusinessGrounding('Okay, now send Mrs. Max a message.')).toBe(true)
  })
})
