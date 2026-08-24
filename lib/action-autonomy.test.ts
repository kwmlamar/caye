import { describe, expect, it } from 'vitest'
import { decideActionAutonomy, type ActionAutonomyContext, type WorkspaceAutonomyPolicy } from './action-autonomy'

const policy: WorkspaceAutonomyPolicy = {
  allowedActions: ['send_email', 'update_record', 'source_leads'],
  maxExternalRecipients: 1,
  maxRecordsAffected: 10,
  maxFinancialImpactCents: 5000,
  auditExternalActions: true,
  budget: { spentCents: 1000, limitCents: 5000 },
}

function action(overrides: Partial<ActionAutonomyContext> = {}): ActionAutonomyContext {
  return {
    action: 'send_email', reversibility: 'recoverable', evidenceSufficient: true,
    affectedPeople: 1, affectedRecords: 1, externalCommunication: true,
    ...overrides,
  }
}

describe('deterministic action autonomy envelope', () => {
  it('acts and audits a bounded, reversible external action even when the model is uncertain', () => {
    expect(decideActionAutonomy(action({ modelUncertain: true }), policy)).toMatchObject({
      decision: 'act_and_audit', audit: true,
    })
  })

  it('acts without audit for a low-risk internal correction', () => {
    expect(decideActionAutonomy(action({ action: 'update_record', externalCommunication: false }), policy).decision).toBe('act')
  })

  it('allows a bounded spend and requires approval once its budget is exceeded', () => {
    expect(decideActionAutonomy(action({ action: 'source_leads', financialImpactCents: 3000, externalCommunication: false }), policy).decision).toBe('act_within_budget')
    expect(decideActionAutonomy(action({ action: 'source_leads', financialImpactCents: 4500, externalCommunication: false }), policy)).toMatchObject({
      decision: 'require_approval', reasons: ['budget_exceeded'],
    })
  })

  it('escalates a bulk action while allowing the equivalent one-recipient action', () => {
    expect(decideActionAutonomy(action(), policy).decision).toBe('act_and_audit')
    expect(decideActionAutonomy(action({ affectedPeople: 2 }), policy)).toMatchObject({
      decision: 'require_approval', reasons: ['external_blast_radius_exceeded'],
    })
  })

  it('preserves hard financial, destructive, security, privacy, and owner-policy boundaries', () => {
    expect(decideActionAutonomy(action({ financialImpactCents: 5001 }), policy).decision).toBe('require_approval')
    expect(decideActionAutonomy(action({ destructive: true, reversibility: 'irreversible' }), policy).decision).toBe('block')
    expect(decideActionAutonomy(action({ hasSecurityImplication: true }), policy).decision).toBe('block')
    expect(decideActionAutonomy(action({ dataSensitivity: 'regulated' }), policy).decision).toBe('block')
    expect(decideActionAutonomy(action({ ownerRule: 'require_approval', hasLearnedProcedure: true }), policy).decision).toBe('require_approval')
  })

  it('does not let a learned procedure or authorization override an unavailable action', () => {
    expect(decideActionAutonomy(action({ action: 'delete_customer', hasExistingAuthorization: true, hasLearnedProcedure: true }), policy).decision).toBe('require_approval')
  })
})
