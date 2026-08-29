import { describe, expect, it } from 'vitest'
import {
  isExplicitBoundedOutreachAuthorization,
  messageSequenceAuthorizesOutreachTarget,
} from './outreach-target-authorization'

const proposal = {
  direction: 'outbound' as const,
  body: [
    'The three proposals are preserved exactly as agreed:',
    '1. Car rentals — Bahamas island-wide (priority 1)',
    '2. Water sports — TCI + Exuma (priority 2)',
    '3. Guesthouses — Kingston + Montego Bay, Jamaica (priority 3)',
  ].join('\n'),
}

const authorization = {
  direction: 'inbound' as const,
  body: 'Keep those priorities. Once staging works, continue with the three test batches without waiting for me.',
}

describe('bounded outreach target authorization', () => {
  it('recognizes explicit bounded authorization, not a bare continue', () => {
    expect(isExplicitBoundedOutreachAuthorization(authorization.body)).toBe(true)
    expect(isExplicitBoundedOutreachAuthorization('continue')).toBe(false)
  })

  it.each([
    ['Car rentals', 'Bahamas island-wide'],
    ['Water sports', 'TCI + Exuma'],
    ['Guesthouses', 'Kingston + Montego Bay, Jamaica'],
  ])('authorizes an exact previously proposed target: %s / %s', (vertical, region) => {
    expect(messageSequenceAuthorizesOutreachTarget(
      [proposal, authorization, { direction: 'inbound', body: 'continue' }],
      { vertical, region },
    )).toBe(true)
  })

  it('rejects a changed target that was not in the proposal', () => {
    expect(messageSequenceAuthorizesOutreachTarget(
      [proposal, authorization],
      { vertical: 'Car rentals', region: 'Florida' },
    )).toBe(false)
  })

  it('rejects authorization that came before the exact proposal', () => {
    expect(messageSequenceAuthorizesOutreachTarget(
      [authorization, proposal, { direction: 'inbound', body: 'continue' }],
      { vertical: 'Car rentals', region: 'Bahamas island-wide' },
    )).toBe(false)
  })

  it('rejects a proposal followed only by generic continue', () => {
    expect(messageSequenceAuthorizesOutreachTarget(
      [proposal, { direction: 'inbound', body: 'continue' }],
      { vertical: 'Water sports', region: 'TCI + Exuma' },
    )).toBe(false)
  })
})
