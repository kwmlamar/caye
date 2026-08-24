import { describe, expect, it } from 'vitest'
import { decideFrontDeskCommunicationAutonomy, hasFrontDeskMutationClaim } from './frontdesk-autonomy'

describe('Front Desk autonomy adapter', () => {
  it('allows a grounded one-customer reply despite model uncertainty', () => {
    expect(
      decideFrontDeskCommunicationAutonomy({ evidenceSufficient: true, modelUncertain: true }),
    ).toMatchObject({
      decision: 'act_and_audit',
      audit: true,
      reasons: ['model_uncertainty_observed', 'bounded_external_action'],
    })
  })

  it.each([
    [{ evidenceSufficient: false, modelUncertain: true }, 'require_approval'],
    [{ evidenceSufficient: true, modelUncertain: true, financialImpactCents: 1 }, 'require_approval'],
    [{ evidenceSufficient: true, modelUncertain: true, bookingOrCommitmentImpact: true }, 'require_approval'],
    [{ evidenceSufficient: true, modelUncertain: true, hasLegalImplication: true }, 'require_approval'],
    [{ evidenceSufficient: true, modelUncertain: true, hasSecurityImplication: true }, 'block'],
    [{ evidenceSufficient: true, modelUncertain: true, dataSensitivity: 'regulated' as const }, 'block'],
    [{ evidenceSufficient: true, modelUncertain: true, destructive: true, bookingOrCommitmentImpact: true }, 'block'],
    [{ evidenceSufficient: true, modelUncertain: true, ownerRule: 'require_approval' as const }, 'require_approval'],
    [{ evidenceSufficient: true, modelUncertain: true, ownerRule: 'block' as const }, 'block'],
  ] as const)('keeps hard boundary %o constrained', (input, decision) => {
    expect(decideFrontDeskCommunicationAutonomy(input).decision).toBe(decision)
  })

  it.each([
    'I booked you for 2 PM.',
    'We cancelled your reservation.',
    'I refunded you.',
    'We applied a discount to your booking.',
    'I moved your booking to Friday.',
  ])('recognizes a state-changing claim: %s', (content) => {
    expect(hasFrontDeskMutationClaim(content)).toBe(true)
  })

  it('does not mistake a factual availability report for a mutation', () => {
    expect(hasFrontDeskMutationClaim('2 PM is available.')).toBe(false)
  })
})
