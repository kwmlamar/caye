import { describe, expect, it } from 'vitest'
import { enforceActionGrounding } from './action-claim-guard'

describe('enforceActionGrounding — external draft claims (CAY-9)', () => {
  it('rejects the real false-completion shape when draft_in_inbox only staged', () => {
    const { text, violations } = enforceActionGrounding(
      'Updated draft is in your inbox on Pam’s thread.',
      [{ name: 'draft_in_inbox', ok: true, pendingOnly: true }]
    )

    expect(violations.map((v) => v.category)).toContain('external-draft')
    expect(text).toContain("I haven't filed that into your email Drafts yet")
  })

  it('rejects a Gmail Drafts completion claim when nothing executed', () => {
    const { violations } = enforceActionGrounding(
      'Done — it is in your Gmail Drafts on Pam’s thread now.',
      []
    )
    expect(violations.map((v) => v.category)).toContain('external-draft')
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
