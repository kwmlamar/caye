import { describe, expect, it } from 'vitest'
import { resolveHoldAcknowledgement } from './hold-acknowledgement'

describe('resolveHoldAcknowledgement', () => {
  it('uses a model-supplied acknowledgement when present', () => {
    expect(
      resolveHoldAcknowledgement({
        acknowledgement: 'Thanks — I will check on that.',
        proposedReply: 'Here is the detailed answer.',
        reason: 'needs owner pricing',
      })
    ).toBe('Thanks — I will check on that.')
  })

  it('backs up a customer hold when the model omits the acknowledgement', () => {
    expect(
      resolveHoldAcknowledgement({
        proposedReply: 'I can arrange airport transportation once we confirm the details.',
        reason: 'custom transport request, needs owner pricing',
      })
    ).toBe('Thanks for reaching out — let me check on that and get back to you shortly.')
  })

  it('keeps silent holds silent for non-customer mail', () => {
    expect(
      resolveHoldAcknowledgement({
        proposedReply: 'Thanks for the offer.',
        reason: 'not a customer message',
      })
    ).toBeUndefined()
  })
})
