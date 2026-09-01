import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import {
  decideActionAutonomy,
  type ActionAutonomyContext,
  type WorkspaceAutonomyPolicy,
} from '@/lib/action-autonomy'
import { resolveWorkspaceDecisionAuthority } from '@/lib/decision-authority'
import { observeAttentionItem } from '@/lib/owner-attention'
import type { RecommendationAuthority, RecommendationReversibility, RecommendationRisk } from './service'

export type RecommendationDecision = 'pending' | 'accepted' | 'rejected' | 'deferred' | 'cancelled'
export type RecommendationDecisionActor = 'founder' | 'operator' | 'system'
export type RecommendationActionKind =
  | 'routine'
  | 'payment_or_money_movement'
  | 'contract'
  | 'destructive_production_change'
  | 'auth_security_authority_change'
  | 'consequential_customer_communication'
  | 'sensitive_outreach'
  | 'database_migration'
  | 'authority_policy_change'

export interface RecordRecommendationDecisionInput {
  recommendationId: string
  decision: RecommendationDecision
  actorKind: RecommendationDecisionActor
  actorId?: string | null
  rationale: string
  authorityProvenance?: Record<string, unknown>
  workspaceId?: string | null
  idempotencyKey?: string | null
  decidedAt?: string | null
}

type RecommendationRow = {
  id: string
  scope: 'operator' | 'workspace'
  workspace_id: string | null
  title: string
  status: 'proposed' | 'accepted' | 'rejected' | 'deferred' | 'withdrawn' | 'superseded'
  reversibility: RecommendationReversibility
  risk_classification: RecommendationRisk
  required_authority: RecommendationAuthority
  fingerprint: string
}

export type RecommendationDecisionPolicyInput = {
  recommendation: Pick<RecommendationRow, 'risk_classification' | 'reversibility' | 'required_authority'>
  actionKind: RecommendationActionKind
  actionContext: ActionAutonomyContext
  workspacePolicy: WorkspaceAutonomyPolicy
}

export type RecommendationDecisionPolicyVerdict = {
  disposition: 'auto_accept' | 'founder_required' | 'blocked'
  reasons: string[]
  authorityGranted: boolean
}

const FOUNDER_ONLY_ACTIONS = new Set<RecommendationActionKind>([
  'payment_or_money_movement',
  'contract',
  'destructive_production_change',
  'auth_security_authority_change',
  'consequential_customer_communication',
  'sensitive_outreach',
  'database_migration',
  'authority_policy_change',
])

export function actionRequiresFounderApproval(
  kind: RecommendationActionKind,
  context: ActionAutonomyContext,
  risk: RecommendationRisk,
): boolean {
  return FOUNDER_ONLY_ACTIONS.has(kind)
    || (context.financialImpactCents ?? 0) > 0
    || context.hasLegalImplication === true
    || context.hasSecurityImplication === true
    || context.destructive === true
    || (context.externalCommunication === true && risk !== 'low')
    || risk === 'high'
    || risk === 'critical'
}

function authorityAlreadyGranted(authority: RecommendationAuthority, context: ActionAutonomyContext): boolean {
  return authority.resolvedBy === 'canonical_authority'
    && typeof authority.principalRef === 'string'
    && authority.principalRef.trim().length > 0
    && context.hasExistingAuthorization === true
}

/** Pure deterministic policy. The model supplies facts, never permission. */
export function evaluateRecommendationDecisionPolicy(input: RecommendationDecisionPolicyInput): RecommendationDecisionPolicyVerdict {
  const { recommendation, actionKind, actionContext, workspacePolicy } = input
  const authorityGranted = authorityAlreadyGranted(recommendation.required_authority, actionContext)

  // Caye can never bootstrap permission to rewrite the policy that grants Caye permission.
  if (actionKind === 'authority_policy_change') {
    return { disposition: 'founder_required', reasons: ['authority_system_self_modification'], authorityGranted }
  }
  if (actionRequiresFounderApproval(actionKind, actionContext, recommendation.risk_classification)) {
    return { disposition: 'founder_required', reasons: ['consequential_action_requires_founder'], authorityGranted }
  }
  if (!authorityGranted) {
    return { disposition: 'founder_required', reasons: ['required_authority_not_already_granted'], authorityGranted: false }
  }
  if (recommendation.risk_classification !== 'low' || recommendation.reversibility !== 'easy') {
    return { disposition: 'founder_required', reasons: ['recommendation_not_low_risk_and_reversible'], authorityGranted }
  }

  const autonomy = decideActionAutonomy(actionContext, workspacePolicy)
  if (autonomy.decision === 'block') return { disposition: 'blocked', reasons: autonomy.reasons, authorityGranted }
  if (autonomy.decision === 'require_approval') return { disposition: 'founder_required', reasons: autonomy.reasons, authorityGranted }
  return { disposition: 'auto_accept', reasons: autonomy.reasons, authorityGranted }
}

export async function recordRecommendationDecision(input: RecordRecommendationDecisionInput) {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('record_caye_recommendation_decision', {
    p_recommendation_id: input.recommendationId,
    p_decision: input.decision,
    p_actor_kind: input.actorKind,
    p_actor_id: input.actorId ?? null,
    p_rationale: input.rationale,
    p_authority_provenance: input.authorityProvenance ?? {},
    p_workspace_id: input.workspaceId ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_decided_at: input.decidedAt ?? null,
  })
  if (error) throw error
  return data
}

async function loadRecommendation(id: string): Promise<RecommendationRow> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_recommendations')
    .select('id,scope,workspace_id,title,status,reversibility,risk_classification,required_authority,fingerprint')
    .eq('id', id)
    .maybeSingle<RecommendationRow>()
  if (error) throw error
  if (!data) throw new Error('recommendation not found')
  return data
}

function scopeMatches(row: RecommendationRow, workspaceId: string | null): boolean {
  return row.scope === 'workspace'
    ? workspaceId !== null && row.workspace_id === workspaceId
    : workspaceId === null && row.workspace_id === null
}

async function requireFounderAttention(row: RecommendationRow, reasons: string[]): Promise<void> {
  if (row.scope !== 'workspace' || !row.workspace_id) return
  await observeAttentionItem({
    workspaceId: row.workspace_id,
    subjectType: 'recommendation_decision',
    subjectId: row.id,
    title: `Recommendation: ${row.title}`,
    priority: 'decision',
    nextAction: 'Founder judgment is required before this recommendation can become execution-eligible.',
    fingerprintParts: [row.id, row.fingerprint, row.risk_classification, row.reversibility, JSON.stringify(row.required_authority), ...reasons],
    blockedOnOperator: true,
    resolvableAutonomously: false,
  })
}

/**
 * Agent 3 integration point: canonical recommendation -> durable decision ->
 * recommendation-level execution eligibility. Existing action/tool gates still
 * own execution and must run after an accepted result.
 */
export async function decideRecommendationForExecution(input: {
  recommendationId: string
  workspaceId: string | null
  actionKind: RecommendationActionKind
  actionContext: ActionAutonomyContext
  workspacePolicy: WorkspaceAutonomyPolicy
  idempotencyKey: string
}) {
  const row = await loadRecommendation(input.recommendationId)
  if (!scopeMatches(row, input.workspaceId)) {
    return { executionEligible: false, disposition: 'blocked' as const, reasons: ['recommendation_workspace_mismatch'], decision: null }
  }
  if (row.status === 'superseded' || row.status === 'withdrawn') {
    return { executionEligible: false, disposition: 'blocked' as const, reasons: ['recommendation_stale_or_withdrawn'], decision: null }
  }

  const verdict = evaluateRecommendationDecisionPolicy({
    recommendation: row,
    actionKind: input.actionKind,
    actionContext: input.actionContext,
    workspacePolicy: input.workspacePolicy,
  })
  const authorityProvenance = {
    requiredAuthority: row.required_authority,
    action: input.actionContext.action,
    deterministicPolicy: 'decideActionAutonomy',
    verdictReasons: verdict.reasons,
  }

  if (verdict.disposition === 'auto_accept') {
    const decision = await recordRecommendationDecision({
      recommendationId: row.id,
      decision: 'accepted',
      actorKind: 'system',
      actorId: 'caye',
      rationale: `Autonomously accepted within granted low-risk reversible authority${verdict.reasons.length ? `: ${verdict.reasons.join(', ')}` : ''}`,
      authorityProvenance,
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
    })
    return { executionEligible: true, disposition: verdict.disposition, reasons: verdict.reasons, decision }
  }

  const decision = await recordRecommendationDecision({
    recommendationId: row.id,
    decision: 'pending',
    actorKind: 'system',
    actorId: 'caye',
    rationale: verdict.reasons.join(', ') || 'founder judgment required',
    authorityProvenance,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
  })
  await requireFounderAttention(row, verdict.reasons)
  return { executionEligible: false, disposition: verdict.disposition, reasons: verdict.reasons, decision }
}

/** Human decision path. Workspace acceptance revalidates existing authority. */
export async function recordHumanRecommendationDecision(input: {
  recommendationId: string
  workspaceId: string | null
  decision: Extract<RecommendationDecision, 'accepted' | 'rejected' | 'deferred' | 'cancelled'>
  actorKind: 'founder' | 'operator'
  actorId: string
  actorOperatorId?: number | null
  actionKind: RecommendationActionKind
  rationale: string
  idempotencyKey: string
}) {
  const row = await loadRecommendation(input.recommendationId)
  if (!scopeMatches(row, input.workspaceId)) throw new Error('recommendation workspace mismatch')
  if (row.status === 'superseded' || row.status === 'withdrawn') throw new Error('stale recommendation cannot be decided')
  if (FOUNDER_ONLY_ACTIONS.has(input.actionKind) && input.actorKind !== 'founder') {
    throw new Error('this recommendation requires explicit founder approval')
  }

  let authorityProvenance: Record<string, unknown> = { requiredAuthority: row.required_authority }
  if (row.scope === 'workspace' && input.decision === 'accepted') {
    const requiredAuthority = row.required_authority.principalRef?.trim()
    if (!requiredAuthority || row.required_authority.resolvedBy !== 'canonical_authority') throw new Error('required recommendation authority is unresolved')
    if (input.actorOperatorId == null) throw new Error('workspace decision actor identity is unavailable')
    const authority = await resolveWorkspaceDecisionAuthority({
      workspaceId: row.workspace_id!,
      actorOperatorId: input.actorOperatorId,
      requiredAuthority,
    })
    if (!authority.actorAuthorized) throw new Error('decision actor does not hold required authority')
    authorityProvenance = { requiredAuthority, resolution: authority.evidence }
  }

  return recordRecommendationDecision({
    recommendationId: row.id,
    decision: input.decision,
    actorKind: input.actorKind,
    actorId: input.actorId,
    rationale: input.rationale,
    authorityProvenance,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
  })
}

export async function recommendationExecutionEligible(recommendationId: string, workspaceId: string | null): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('caye_recommendation_execution_eligible', {
    p_recommendation_id: recommendationId,
    p_workspace_id: workspaceId,
  })
  if (error) return false
  return data === true
}
