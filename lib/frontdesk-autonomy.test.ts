import { describe, expect, it } from 'vitest'
import { decideFrontDeskCommunicationAutonomy } from './frontdesk-autonomy'

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
})
