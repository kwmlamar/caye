import { describe, expect, it } from 'vitest'
import {
  HUMAN_FACING_VOICE_INSTRUCTIONS,
  sanitizeHumanFacingText,
} from './human-facing-voice'

describe('human-facing voice policy', () => {
  it('requires plain, concise, high-school-level human-facing writing', () => {
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('high-school reading level or easier')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('plain, everyday words')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('short and direct')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('short sentences')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('corporate language')
  })

  it('keeps the policy scoped away from internal structured reasoning', () => {
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('text a person will read')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('Do not simplify or rewrite internal reasoning')
  })

  it('forbids all long dash characters at the last human-facing boundary', () => {
    const result = sanitizeHumanFacingText('I checked it — ready. Hours 9–11. Status ― open.')
    expect(result).not.toMatch(/[—–―]/)
    expect(result).toContain('9-11')
  })

  it('trims accidental outer whitespace', () => {
    expect(sanitizeHumanFacingText('  Done. The email was sent.  ')).toBe('Done. The email was sent.')
  })
})
