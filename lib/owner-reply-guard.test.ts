import { describe, expect, it } from 'vitest'
import { ownerAlreadyAnsweredInbound, ownerReplyAddressesHold } from './owner-reply-guard'

describe('owner reply lifecycle guard', () => {
  const ownerReply = {
    sentAt: '2026-08-13T18:25:03.396Z',
    metadata: { source: 'zoho_sent', sent_by: 'human' },
  }

  it('suppresses Caye when the owner has already answered the same inbound turn', () => {
    expect(ownerAlreadyAnsweredInbound(ownerReply, '2026-08-13T18:21:19.758Z')).toBe(true)
  })

  it('lets Caye reevaluate a customer reply after the owner resolved the hold', () => {
    // Caye handling → Needs You → owner replies → waiting on customer →
    // customer replies. A past owner reply is evidence, not a permanent hold.
    expect(ownerAlreadyAnsweredInbound(ownerReply, '2026-08-13T18:26:48.549Z')).toBe(false)
  })

  it('does not suppress a later customer turn merely because the owner replied recently', () => {
    const unrelatedCourtesyReply = {
      sentAt: '2026-08-13T18:25:03.396Z',
      senderAttribution: 'human_via_external',
    }
    expect(ownerAlreadyAnsweredInbound(unrelatedCourtesyReply, '2026-08-13T18:26:48.549Z')).toBe(false)
  })

  it('resolves only the hold the owner actually addressed', () => {
    expect(ownerReplyAddressesHold(
      'We will coordinate the NBCUniversal film crew to use the tram to the Casino Pavilion.',
      ['RWB port access denied for NBCUniversal film crew', 'The tram-to-Casino-Pavilion solution works well.']
    )).toBe(true)
    expect(ownerReplyAddressesHold(
      'Thanks for getting back to us — appreciate it.',
      ['Pricing exception: approve the custom $450 rate before replying.']
    )).toBe(false)
  })
})
