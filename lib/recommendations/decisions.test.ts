import { describe, expect, it } from 'vitest'
import { evaluateRecommendationDecisionPolicy } from './decisions'
import type { ActionAutonomyContext, WorkspaceAutonomyPolicy } from '@/lib/action-autonomy'

const policy: WorkspaceAutonomyPolicy = {
  allowedActions: ['scan_opportunity', 'update_copy'],
  maxExternalRecipients: 1,
  maxRecordsAffected: 10,
  maxFinancialImpactCents: 0,
  auditExternalActions: true,
}

const recommendation = {
  risk_classification: 'low' as const,
  reversibility: 'easy' as const,
  required_authority: {
    principalType: 'workspace' as const,
    principalRef: 'business.policy',
    resolvedBy: 'canonical_authority' as const,
  },
}

function action(overrides: Partial<ActionAutonomyContext> = {}): ActionAutonomyContext {
  return {
    action: 'scan_opportunity',
    reversibility: 'reversible',
    evidenceSufficient: true,
    hasExistingAuthorization: true,
    ...overrides,
  }
}

describe('durable recommendation decision policy', () => {
  it('auto-accepts only a low-risk reversible recommendation under granted authority', () => {
    expect(evaluateRecommendationDecisionPolicy({ recommendation, actionKind: 'routine', actionContext: action(), workspacePolicy: policy })).toMatchObject({
      disposition: 'auto_accept',
      authorityGranted: true,
    })
  })

  it('denies the same action when existing authority is absent', () => {
    expect(evaluateRecommendationDecisionPolicy({ recommendation, actionKind: 'routine', actionContext: action({ hasExistingAuthorization: false }), workspacePolicy: policy })).toMatchObject({
      disposition: 'founder_required',
      authorityGranted: false,
      reasons: ['required_authority_not_already_granted'],
    })
  })

  it('keeps high-risk recommendations blocked on founder judgment', () => {
    expect(evaluateRecommendationDecisionPolicy({
      recommendation: { ...recommendation, risk_classification: 'high' },
      actionKind: 'routine',
      actionContext: action(),
      workspacePolicy: policy,
    }).disposition).toBe('founder_required')
  })

  it('requires founder approval for money movement even when the generic action envelope is otherwise permissive', () => {
    expect(evaluateRecommendationDecisionPolicy({ recommendation, actionKind: 'payment_or_money_movement', actionContext: action(), workspacePolicy: policy }).disposition).toBe('founder_required')
  })

  it('requires founder approval for consequential customer communication', () => {
    expect(evaluateRecommendationDecisionPolicy({ recommendation, actionKind: 'consequential_customer_communication', actionContext: action({ externalCommunication: true }), workspacePolicy: policy }).disposition).toBe('founder_required')
  })

  it('requires founder approval for database migrations', () => {
    expect(evaluateRecommendationDecisionPolicy({ recommendation, actionKind: 'database_migration', actionContext: action(), workspacePolicy: policy }).disposition).toBe('founder_required')
  })

  it('never allows authority-system self-modification to auto-accept', () => {
    expect(evaluateRecommendationDecisionPolicy({ recommendation, actionKind: 'authority_policy_change', actionContext: action(), workspacePolicy: policy })).toMatchObject({
      disposition: 'founder_required',
      reasons: ['authority_system_self_modification'],
    })
  })

  it('fails closed when the existing action-autonomy policy blocks the action', () => {
    expect(evaluateRecommendationDecisionPolicy({
      recommendation,
      actionKind: 'routine',
      actionContext: action({ action: 'unknown_action' }),
      workspacePolicy: policy,
    }).disposition).toBe('founder_required')
  })
})
