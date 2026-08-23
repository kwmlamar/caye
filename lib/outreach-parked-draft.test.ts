import { describe, expect, it } from 'vitest'
import { getRevalidatableParkedDraft } from './outreach-parked-draft'

describe('getRevalidatableParkedDraft', () => {
  it('makes a queued first-touch draft available for current-policy revalidation', () => {
    expect(getRevalidatableParkedDraft({
      humanAgentEnabled: true,
      metadata: { hold_kind: 'outreach_first_touch', subject: 'A quick question', proposed_reply: 'Hi there,' },
      hasUnansweredReply: false,
      action: 'send_first_touch',
    })).toEqual({ subject: 'A quick question', body: 'Hi there,' })
  })

  it('never treats a generic owner hold, a mismatched cadence draft, or an unanswered reply as releasable', () => {
    const base = { humanAgentEnabled: true, hasUnansweredReply: false, action: 'send_first_touch' as const }
    expect(getRevalidatableParkedDraft({ ...base, metadata: { proposed_reply: 'Review me' } })).toBeNull()
    expect(getRevalidatableParkedDraft({ ...base, metadata: { hold_kind: 'outreach_followup', proposed_reply: 'Review me' } })).toBeNull()
    expect(getRevalidatableParkedDraft({
      ...base,
      hasUnansweredReply: true,
      metadata: { hold_kind: 'outreach_first_touch', proposed_reply: 'Review me' },
    })).toBeNull()
  })
})
