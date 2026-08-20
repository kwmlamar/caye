import { describe, expect, it } from 'vitest'
import { enforceActionGrounding } from './action-claim-guard'

describe('enforceActionGrounding — external draft claims (CAY-9)', () => {
  it.each([
    'Updated draft is in your inbox on Pam’s thread.',
    'Drafted into your inbox on Pam’s thread — subject "Re: Tour Booking".',
    'It’s filed in your email Drafts folder now.',
    'Done — it is in your Gmail Drafts on Pam’s thread now.',
  ])('rejects a false external-draft completion claim without leaking mailbox plumbing: %s', (reply) => {
    const { text, violations } = enforceActionGrounding(reply, [
      { name: 'draft_in_inbox', ok: true, pendingOnly: true },
    ])

    expect(violations.map((v) => v.category)).toContain('external-draft')
    expect(text).toContain("Here's the draft for your review:")
    expect(text).not.toMatch(/haven't filed|email Drafts yet/i)
  })

  it('allows the claim after draft_in_inbox actually executed', () => {
    const reply = 'Done — it is in your Gmail Drafts on Pam’s thread now.'
    const { text, violations } = enforceActionGrounding(reply, [
      { name: 'confirm_pending_action', ok: true },
      { name: 'draft_in_inbox', ok: true, pendingOnly: false },
    ])
    expect(violations).toHaveLength(0)
    expect(text).toBe(reply)
  })
})
