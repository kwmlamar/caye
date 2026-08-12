import { describe, it, expect } from 'vitest'
import { decideAuthority, type AuthorityInput } from './authority'

function input(over: Partial<AuthorityInput> = {}): AuthorityInput {
  return { action: 'send_followup', ...over }
}

describe('decideAuthority', () => {
  it('lets Caye act on routine outbound', () => {
    expect(decideAuthority(input()).tier).toBe('auto')
    expect(decideAuthority(input({ action: 'send_first_touch' })).tier).toBe('auto')
    expect(decideAuthority(input({ action: 'reply_to_prospect' })).tier).toBe('auto')
  })

  it('lets Caye disqualify a bad-fit prospect on her own', () => {
    // Recognising someone should be left alone is core competence. Routing
    // it through Lamar would make stopping slower than continuing.
    expect(decideAuthority(input({ action: 'mark_disqualified' })).tier).toBe('auto')
    expect(decideAuthority(input({ action: 'mark_cold' })).tier).toBe('auto')
  })

  it('escalates any matched escalation category, outranking everything else', () => {
    const v = decideAuthority(input({ triggers: ['legal_or_contract'] }))
    expect(v.tier).toBe('escalate')
    expect(v.escalationCategory).toBe('legal_or_contract')
  })

  it('never returns auto when an escalation category matched, even for a routine action', () => {
    for (const action of ['send_first_touch', 'send_followup', 'reply_to_prospect'] as const) {
      expect(decideAuthority(input({ action, triggers: ['refund_or_billing'] })).tier).toBe('escalate')
    }
  })

  it('holds a draft that failed the guards rather than sending it', () => {
    const v = decideAuthority(input({ draftFailedGuards: true }))
    expect(v.tier).toBe('approval')
    expect(v.reasons).toContain('draft_failed_guards')
  })

  it('preserves work as approval (not silent drop) when paused or capped', () => {
    expect(decideAuthority(input({ outreachPaused: true })).tier).toBe('approval')
    expect(decideAuthority(input({ atDailyCap: true })).tier).toBe('approval')
  })

  it('does not apply the outbound pause to answering someone who wrote in', () => {
    // A bounce-triggered cold-send pause must never stop Caye replying to a
    // lead who already engaged — that was the whole point of keeping the
    // two switches separate.
    const v = decideAuthority(input({ action: 'reply_to_prospect', outreachPaused: true, atDailyCap: true }))
    expect(v.tier).toBe('auto')
  })

  it('treats model uncertainty as downgrade-only, never an upgrade', () => {
    expect(decideAuthority(input({ modelUncertain: true })).tier).toBe('approval')
    // Certainty cannot buy its way past an escalation category.
    expect(
      decideAuthority(input({ modelUncertain: false, triggers: ['press_or_media'] })).tier
    ).toBe('escalate')
  })

  it('requires approval to expand targeting', () => {
    expect(decideAuthority(input({ action: 'propose_new_segment' })).tier).toBe('approval')
  })

  it('fails closed on an unclassified action', () => {
    const v = decideAuthority(input({ action: 'something_new' as never }))
    expect(v.tier).toBe('approval')
    expect(v.reasons).toContain('unclassified_action')
  })
})
