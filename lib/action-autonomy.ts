/**
 * Deterministic action-autonomy envelope.
 *
 * The model may choose an intended action, but it never chooses whether the
 * action is permitted. Callers supply observed, structured facts and a
 * workspace policy; this module returns the executable disposition.
 *
 * This is intentionally pure. Domain adapters (Sales first) are responsible
 * for obtaining policy, authorization, evidence, and execution receipts.
 */

export type AutonomyDecision =
  | 'act'
  | 'act_and_audit'
  | 'act_within_budget'
  | 'require_approval'
  | 'block'

export type Reversibility = 'reversible' | 'recoverable' | 'difficult_to_recover' | 'irreversible'
export type DataSensitivity = 'none' | 'internal' | 'confidential' | 'regulated'

export interface AutonomyBudget {
  /** Amount already committed in the active budget window, in cents. */
  spentCents: number
  /** Deterministic workspace limit for that window, in cents. */
  limitCents: number
}

export interface WorkspaceAutonomyPolicy {
  /** Unknown action names fail closed unless a domain adapter explicitly enables them. */
  allowedActions: readonly string[]
  maxExternalRecipients: number
  maxRecordsAffected: number
  maxFinancialImpactCents: number
  auditExternalActions?: boolean
  budget?: AutonomyBudget
}

export interface ActionAutonomyContext {
  action: string
  reversibility: Reversibility
  evidenceSufficient: boolean
  affectedPeople?: number
  affectedRecords?: number
  financialImpactCents?: number
  dataSensitivity?: DataSensitivity
  hasLegalImplication?: boolean
  hasSecurityImplication?: boolean
  destructive?: boolean
  externalCommunication?: boolean
  /** Deterministic owner policy match, not an LLM interpretation. */
  ownerRule?: 'require_approval' | 'block'
  /** An authorization/procedure can guide execution but cannot relax hard limits below. */
  hasExistingAuthorization?: boolean
  hasLearnedProcedure?: boolean
  /** Advisory only. Uncertainty is never an escalation trigger on its own. */
  modelUncertain?: boolean
}

export interface AutonomyVerdict {
  decision: AutonomyDecision
  reasons: string[]
  audit: boolean
}

const nonNegative = (value: number | undefined) => Math.max(0, value ?? 0)

/**
 * Resolve the safe operating envelope. Ordering is part of the policy:
 * hard boundaries and explicit owner rules always outrank authorization,
 * learned procedures, confidence, and ordinary workspace allowances.
 */
export function decideActionAutonomy(
  context: ActionAutonomyContext,
  policy: WorkspaceAutonomyPolicy,
): AutonomyVerdict {
  const reasons: string[] = []
  const people = nonNegative(context.affectedPeople)
  const records = nonNegative(context.affectedRecords)
  const spend = nonNegative(context.financialImpactCents)
  // These are observability/context signals, never authority overrides.
  // A procedure can make execution more consistent; it cannot turn a
  // security-sensitive or out-of-budget action into an allowed one.
  const operatingReasons: string[] = []
  if (context.hasExistingAuthorization) operatingReasons.push('existing_authorization_in_scope')
  if (context.hasLearnedProcedure) operatingReasons.push('learned_procedure_applied')
  if (context.modelUncertain) operatingReasons.push('model_uncertainty_observed')

  if (!policy.allowedActions.includes(context.action)) {
    return { decision: 'require_approval', reasons: ['action_not_enabled_by_workspace_policy'], audit: false }
  }
  if (context.ownerRule === 'block') {
    return { decision: 'block', reasons: ['blocked_by_owner_policy'], audit: false }
  }
  if (context.hasSecurityImplication || context.dataSensitivity === 'regulated') {
    return { decision: 'block', reasons: ['security_or_regulated_privacy_boundary'], audit: false }
  }
  if (context.destructive && context.reversibility === 'irreversible') {
    return { decision: 'block', reasons: ['irreversible_destructive_action'], audit: false }
  }
  if (context.ownerRule === 'require_approval') {
    return { decision: 'require_approval', reasons: ['approval_required_by_owner_policy'], audit: false }
  }
  if (context.hasLegalImplication || context.reversibility === 'irreversible') {
    return { decision: 'require_approval', reasons: ['legal_or_irreversible_consequence'], audit: false }
  }
  if (!context.evidenceSufficient) {
    return { decision: 'require_approval', reasons: ['insufficient_deterministic_evidence'], audit: false }
  }
  if (people > policy.maxExternalRecipients) {
    return { decision: 'require_approval', reasons: ['external_blast_radius_exceeded'], audit: false }
  }
  if (records > policy.maxRecordsAffected) {
    return { decision: 'require_approval', reasons: ['record_blast_radius_exceeded'], audit: false }
  }
  if (spend > policy.maxFinancialImpactCents) {
    return { decision: 'require_approval', reasons: ['financial_limit_exceeded'], audit: false }
  }
  if (spend > 0) {
    const budget = policy.budget
    if (!budget || budget.spentCents + spend > budget.limitCents) {
      return { decision: 'require_approval', reasons: ['budget_exceeded'], audit: false }
    }
    return { decision: 'act_within_budget', reasons: [...operatingReasons, 'within_workspace_budget'], audit: true }
  }

  if (context.externalCommunication && policy.auditExternalActions !== false) {
    reasons.push(...operatingReasons, 'bounded_external_action')
    return { decision: 'act_and_audit', reasons, audit: true }
  }
  return { decision: 'act', reasons: operatingReasons, audit: false }
}
