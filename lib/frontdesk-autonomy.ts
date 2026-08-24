import {
  decideActionAutonomy,
  type ActionAutonomyContext,
  type AutonomyDecision,
  type AutonomyVerdict,
} from './action-autonomy'

/**
 * Front Desk's deliberately small mapping into the shared autonomy envelope.
 *
 * This migration covers communication of already-established customer facts,
 * not booking or payment mutations.  Those mutations retain their dedicated
 * deterministic policy gates until they are migrated independently.
 */
export type FrontDeskCommunicationKind = 'grounded_customer_reply'

export interface FrontDeskCommunicationInput {
  evidenceSufficient: boolean
  modelUncertain: boolean
  /** Deterministic signals supplied by a caller when this is not routine communication. */
  financialImpactCents?: number
  bookingOrCommitmentImpact?: boolean
  destructive?: boolean
  dataSensitivity?: ActionAutonomyContext['dataSensitivity']
  hasLegalImplication?: boolean
  hasSecurityImplication?: boolean
  ownerRule?: ActionAutonomyContext['ownerRule']
}

export interface FrontDeskAutonomyAudit {
  verdict: AutonomyDecision
  action_kind: FrontDeskCommunicationKind
  reasons: string[]
  evidence_sufficient: boolean
  external_recipients: 1
  records_affected: 1
}

const POLICY = {
  allowedActions: ['grounded_customer_reply'],
  maxExternalRecipients: 1,
  maxRecordsAffected: 1,
  maxFinancialImpactCents: 0,
  auditExternalActions: true,
} as const

/**
 * Classify a one-customer factual reply. Model uncertainty is recorded as a
 * diagnostic by the shared envelope, never treated as owner-attention policy.
 */
export function decideFrontDeskCommunicationAutonomy(
  input: FrontDeskCommunicationInput,
): AutonomyVerdict {
  return decideActionAutonomy(
    {
      action: 'grounded_customer_reply',
      reversibility: input.destructive ? 'irreversible' : 'recoverable',
      evidenceSufficient: input.evidenceSufficient,
      affectedPeople: 1,
      affectedRecords: 1,
      financialImpactCents: input.financialImpactCents ?? 0,
      dataSensitivity: input.dataSensitivity ?? 'none',
      hasLegalImplication: input.hasLegalImplication,
      hasSecurityImplication: input.hasSecurityImplication,
      destructive: input.destructive,
      // Communication is the only enabled Front Desk action in this PR.
      // A booking/commitment signal therefore requires approval even when it
      // is otherwise grounded; mutation migration is deliberately separate.
      ownerRule: input.ownerRule ?? (input.bookingOrCommitmentImpact ? 'require_approval' : undefined),
      externalCommunication: true,
      modelUncertain: input.modelUncertain,
    },
    POLICY,
  )
}

export function isAutonomousCommunication(verdict: AutonomyVerdict): boolean {
  return verdict.decision === 'act' || verdict.decision === 'act_and_audit'
}

export function frontDeskAutonomyAudit(
  verdict: AutonomyVerdict,
  evidenceSufficient: boolean,
): FrontDeskAutonomyAudit {
  return {
    verdict: verdict.decision,
    action_kind: 'grounded_customer_reply',
    reasons: verdict.reasons,
    evidence_sufficient: evidenceSufficient,
    external_recipients: 1,
    records_affected: 1,
  }
}
