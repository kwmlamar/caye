import { describe, it, expect } from 'vitest'

import {
  findOutreachDraftIssues,
  describeDraftIssues,
  BANNED_HEDGE_PHRASES,
} from './outreach-draft-guard'

// Regression suite for the 2026-08-01 follow-up batch: 7 of 31 sent emails
// carried banned hedge phrases and 1 shipped a literal "[First Name]" to a
// real prospect, despite the generator's prompt forbidding both.
describe('findOutreachDraftIssues', () => {
  it('passes a clean draft', () => {
    const draft =
      'Hey Lexx,\n\nChecking if my last message made it to you. If you want to see how ' +
      'Caye handles bookings for a salon, go to meetcaye.com and hit "Try for Free".\n\nLamar'
    expect(findOutreachDraftIssues(draft)).toEqual([])
  })

  it('catches the exact placeholder that shipped to a real prospect', () => {
    const issues = findOutreachDraftIssues('Hey [First Name],\n\nChecking in on my last note.')
    expect(issues).toContainEqual({ kind: 'placeholder', detail: '[First Name]' })
  })

  it('catches mustache and single-brace placeholders too', () => {
    expect(findOutreachDraftIssues('Hi {{business_name}} team')).toContainEqual({
      kind: 'placeholder',
      detail: '{{business_name}}',
    })
    expect(findOutreachDraftIssues('Hi {city} folks')).toContainEqual({
      kind: 'placeholder',
      detail: '{city}',
    })
  })

  it('flags every banned hedge phrase, case-insensitively', () => {
    for (const phrase of BANNED_HEDGE_PHRASES) {
      const issues = findOutreachDraftIssues(`Hey there. ${phrase.toUpperCase()}. Lamar`)
      expect(
        issues.some((i) => i.kind === 'hedge_phrase'),
        `expected "${phrase}" to be flagged`
      ).toBe(true)
    }
  })

  it('reports one issue, not two, when a short banned phrase nests inside a longer one', () => {
    const issues = findOutreachDraftIssues('No worries at all if the timing is off.')
    const hedges = issues.filter((i) => i.kind === 'hedge_phrase')
    expect(hedges).toHaveLength(1)
    expect(hedges[0].detail).toBe('no worries at all')
  })

  it('does not flag ordinary prose that merely resembles a placeholder', () => {
    // Sentence punctuation inside brackets means it is prose, not a field.
    const issues = findOutreachDraftIssues('We ran the numbers [and they were good, honestly].')
    expect(issues.filter((i) => i.kind === 'placeholder')).toEqual([])
  })

  it('deduplicates a placeholder repeated in the same draft', () => {
    const issues = findOutreachDraftIssues('[First Name], hello [First Name].')
    expect(issues.filter((i) => i.kind === 'placeholder')).toHaveLength(1)
  })

  it('is not corrupted by regex lastIndex carrying across calls', () => {
    const draft = 'Hey [First Name],'
    // Same input twice must give the same answer — /g regexes at module
    // scope resume from lastIndex unless reset.
    expect(findOutreachDraftIssues(draft)).toEqual(findOutreachDraftIssues(draft))
  })

  it('reports placeholders and hedges together', () => {
    const issues = findOutreachDraftIssues('Hey [First Name], just floating this back up.')
    expect(issues.some((i) => i.kind === 'placeholder')).toBe(true)
    expect(issues.some((i) => i.kind === 'hedge_phrase')).toBe(true)
  })
})

describe('describeDraftIssues', () => {
  it('names the offending text so the operator can fix it', () => {
    const msg = describeDraftIssues(
      findOutreachDraftIssues('Hey [First Name], just floating this back up.')
    )
    expect(msg).toContain('[First Name]')
    expect(msg).toContain('just floating this back up')
    expect(msg).toContain('Rewrite it')
  })
})
