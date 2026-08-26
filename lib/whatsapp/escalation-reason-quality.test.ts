import { describe, it, expect } from 'vitest'
import { assessEscalationReasonQuality } from './escalation-reason-quality'

describe('assessEscalationReasonQuality', () => {
  it('passes a real handoff note ending in a concrete proposal', () => {
    // The Jonathan Garcia shape: names the gap and ends in a yes/no ask.
    const reason =
      'Jonathan asked about coordinating snorkeling/Snuba through a partner. We do not have an ' +
      'approved partner or pricing rule on file for this. Want me to tell him the team will follow ' +
      'up, or do you want to quote him directly once you confirm the partner?'
    expect(assessEscalationReasonQuality(reason)).toEqual({ ok: true, concerns: [] })
  })

  it('flags a bare uncertainty phrase with no concrete blocker', () => {
    expect(assessEscalationReasonQuality('Not sure.')).toEqual({
      ok: false,
      concerns: ['too_short', 'boilerplate_uncertainty'],
    })
    expect(assessEscalationReasonQuality("I don't know")).toEqual({
      ok: false,
      concerns: ['too_short', 'boilerplate_uncertainty', 'no_sentence_structure'],
    })
  })

  it('flags text with no sentence structure even if long enough', () => {
    expect(assessEscalationReasonQuality('customer asked about pricing for large group booking')).toEqual({
      ok: false,
      concerns: ['no_sentence_structure'],
    })
  })

  it('does not false-positive on a real sentence that merely contains a hedge word mid-clause', () => {
    const reason =
      "I'm not sure if $90 or $110 is current for the sunset tour — the last two bookings priced it " +
      'differently and I do not want to quote the wrong one.'
    expect(assessEscalationReasonQuality(reason)).toEqual({ ok: true, concerns: [] })
  })

  it('flags an empty or whitespace-only reason as too short', () => {
    expect(assessEscalationReasonQuality('   ').ok).toBe(false)
    expect(assessEscalationReasonQuality('').concerns).toContain('too_short')
  })
})
