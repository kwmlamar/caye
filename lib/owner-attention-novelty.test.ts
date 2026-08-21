import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  isNonActionableOwnerObservation,
  ownerAttentionReasonCode,
} from './owner-attention-sync'

describe('CAY-99 owner attention novelty gate', () => {
  it.each(['Thank you!', 'Thanks', 'OK', 'Got it.', 'Perfect!', '👍'])(
    'suppresses courtesy acknowledgement %s',
    (preview) => {
      expect(
        isNonActionableOwnerObservation({
          lastSenderType: 'customer',
          lastMessagePreview: preview,
        })
      ).toBe(true)
    }
  )

  it('does not suppress a substantive customer question that contains thanks', () => {
    expect(
      isNonActionableOwnerObservation({
        lastSenderType: 'customer',
        lastMessagePreview: 'Thanks — can we move the ferry to 3pm?',
      })
    ).toBe(false)
  })

  it('does not suppress business-authored messages', () => {
    expect(
      isNonActionableOwnerObservation({
        lastSenderType: 'business',
        lastMessagePreview: 'Thank you!',
      })
    ).toBe(false)
  })

  it('emits required observability reason codes', () => {
    expect(ownerAttentionReasonCode({ nonActionable: true })).toBe(
      'suppressed_non_actionable'
    )
    expect(
      ownerAttentionReasonCode({
        nonActionable: false,
        stateFingerprint: 'same',
        notifiedFingerprint: 'same',
      })
    ).toBe('suppressed_duplicate')
    expect(
      ownerAttentionReasonCode({
        nonActionable: false,
        stateFingerprint: 'new',
        notifiedFingerprint: 'old',
      })
    ).toBe('surfaced_actionable')
  })
})
