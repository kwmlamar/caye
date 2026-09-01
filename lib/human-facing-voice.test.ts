import { describe, expect, it } from 'vitest'
import {
  HUMAN_FACING_VOICE_INSTRUCTIONS,
  sanitizeHumanFacingText,
} from './human-facing-voice'

describe('human-facing voice policy', () => {
  it('requires plain, short, high-school-level human-facing writing', () => {
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('high-school reading level or easier')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('plain, everyday words')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('short and direct')
  })

  it('keeps the policy scoped away from internal structured reasoning', () => {
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('text a person will read')
    expect(HUMAN_FACING_VOICE_INSTRUCTIONS).toContain('Do not simplify or rewrite internal reasoning')
  })

  it('removes em and en dashes at the last human-facing boundary', () => {
    const result = sanitizeHumanFacingText('I checked it — the booking is ready. Hours are 9–11 AM.')
    expect(result).toBe('I checked it. The booking is ready. Hours are 9-11 AM.')
    expect(result).not.toMatch(/[—–]/)
  })

  it('trims accidental outer whitespace without changing clean wording', () => {
    expect(sanitizeHumanFacingText('  Done. The email was sent.  ')).toBe('Done. The email was sent.')
  })
})
