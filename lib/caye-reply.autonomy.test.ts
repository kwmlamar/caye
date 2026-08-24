import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { resolveGroundedUncertainFrontDeskReply } from './caye-reply'

describe('live caye-reply autonomy seam', () => {
  it('executes a grounded uncertain reply without owner-review fields and audits the autonomous verdict', () => {
    const decision = resolveGroundedUncertainFrontDeskReply('The 2 PM slot is available.')

    expect(decision).toMatchObject({
      action: 'reply',
      content: 'The 2 PM slot is available.',
      autonomyAudit: {
        verdict: 'act_and_audit',
        action_kind: 'grounded_customer_reply',
        evidence_sufficient: true,
        external_recipients: 1,
        records_affected: 1,
      },
    })
    expect(decision).not.toHaveProperty('needsOwnerFollowup')
    expect(decision).not.toHaveProperty('ownerNote')
    if (decision.action !== 'reply') throw new Error('expected autonomous reply')
    expect(JSON.stringify(decision.autonomyAudit)).not.toContain('2 PM slot')
  })

  it.each([
    'I booked you for 2 PM.',
    'I cancelled your reservation.',
    'I refunded you.',
    'I applied a discount to your booking.',
    'I moved your booking to Friday.',
  ])('does not route an unexecuted mutation claim through communication autonomy: %s', (content) => {
    expect(resolveGroundedUncertainFrontDeskReply(content)).toMatchObject({ action: 'hold' })
  })
})
