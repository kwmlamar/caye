import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { resolveWorkspaceDecisionAuthority } from '@/lib/decision-authority'
import { observeAttentionItem } from '@/lib/owner-attention'
import { runToolWithRecovery } from '@/lib/caye-agent/orchestrator'
import { evaluateRecommendationDecisionPolicy } from './decisions'
import {
  actionContextForRecommendationPlan,
  actionKindForRecommendationPlan,
  toolForRecommendationPlan,
  validateRecommendationActionPlan,
  workspacePolicyForRecommendationPlan,
} from './action-plan'
import type { RecommendationActionRuntime, RecommendationOperationInspection } from './action-operation'
import type { RecommendationAuthority, RecommendationReversibility, RecommendationRisk } from './service'

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function executionState(status: string | null | undefined): RecommendationOperationInspection['executionState'] {
  if (status === 'pending') return 'approved_queued'
  if (status === 'processing') return 'acting_now'
  if (status === 'synced') return 'completed'
  if (status === 'dead_letter') return 'failed_needs_attention'
  return null
}

async function currentAuthority(input: {
  workspaceId: string
  authority: RecommendationAuthority
  decisionActorKind: string
  decisionProvenance: Record<string, unknown>
}) {
  if (input.decisionActorKind === 'founder' && input.authority.principalType === 'personal') return true
  const required = input.authority.principalRef?.trim()
  if (!required || input.authority.resolvedBy !== 'canonical_authority') return false
  const resolutionEvidence = objectValue(input.decisionProvenance.resolution)
  const actorOperatorId = typeof resolutionEvidence.actorOperatorId === 'number'
    ? resolutionEvidence.actorOperatorId
    : typeof resolutionEvidence.actorOperatorId === 'string' && /^\d+$/.test(resolutionEvidence.actorOperatorId)
      ? Number(resolutionEvidence.actorOperatorId)
      : null
  const resolution = await resolveWorkspaceDecisionAuthority({
    workspaceId: input.workspaceId,
    actorOperatorId: input.decisionActorKind === 'operator' ? actorOperatorId : null,
    requiredAuthority: required,
  })
  if (input.decisionActorKind === 'operator') return resolution.actorAuthorized
  return resolution.authorizedPrincipals.length > 0
}

export function createProductionRecommendationActionRuntime(): RecommendationActionRuntime {
  return {
    async inspect(recommendationId, workspaceId) {
      const db = createServiceClient()
      const { data: rec, error } = await db
        .from('caye_recommendations')
        .select('id,workspace_id,status,superseded_at')
        .eq('id', recommendationId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (error) throw error
      if (!rec || rec.superseded_at || ['superseded', 'withdrawn'].includes(rec.status)) return null
      const [{ data: version, error: versionError }, { data: decision, error: decisionError }, { data: operation, error: operationError }] = await Promise.all([
        db.rpc('caye_recommendation_version', { p_recommendation_id: recommendationId }),
        db.from('caye_recommendation_decisions')
          .select('id,decision,recommendation_version,authority_provenance')
          .eq('recommendation_id', recommendationId)
          .order('decided_at', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        db.from('caye_pending_operations')
          .select('status,updated_at')
          .eq('workspace_id', workspaceId)
          .eq('operation', 'recommendation_action')
          .contains('payload', { recommendation_id: recommendationId })
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (versionError || decisionError || operationError || typeof version !== 'string') throw versionError ?? decisionError ?? operationError ?? new Error('recommendation version unavailable')
      const projected = objectValue(decision?.authority_provenance).recommendationExecutionState
      return {
        recommendationVersion: version,
        latestDecisionId: decision?.id ?? null,
        latestDecision: (decision?.decision as RecommendationOperationInspection['latestDecision']) ?? null,
        executionState: (projected === 'approved_queued' || projected === 'acting_now' || projected === 'completed' || projected === 'failed_needs_attention')
          ? projected
          : executionState(operation?.status),
      }
    },

    async execute(input) {
      const db = createServiceClient()
      const [{ data: rec, error: recError }, { data: version, error: versionError }, { data: eligible, error: eligibleError }, { data: decision, error: decisionError }] = await Promise.all([
        db.from('caye_recommendations')
          .select('id,workspace_id,status,superseded_at,risk_classification,reversibility,required_authority,provenance')
          .eq('id', input.recommendationId)
          .eq('workspace_id', input.workspaceId)
          .maybeSingle(),
        db.rpc('caye_recommendation_version', { p_recommendation_id: input.recommendationId }),
        db.rpc('caye_recommendation_execution_eligible', { p_recommendation_id: input.recommendationId, p_workspace_id: input.workspaceId }),
        db.from('caye_recommendation_decisions')
          .select('id,decision,actor_kind,authority_provenance,recommendation_version')
          .eq('recommendation_id', input.recommendationId)
          .order('decided_at', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (recError || versionError || eligibleError || decisionError) return { status: 'retryable_failure', error: (recError ?? versionError ?? eligibleError ?? decisionError)?.message ?? 'recommendation revalidation failed' }
      if (!rec || rec.superseded_at || ['superseded', 'withdrawn'].includes(rec.status)) return { status: 'failed_needs_attention', error: 'recommendation is no longer current', consequential: false }
      if (version !== input.recommendationVersion || eligible !== true) return { status: 'failed_needs_attention', error: 'recommendation approval is no longer execution-eligible', consequential: true }
      if (!decision || decision.id !== input.decisionId || decision.decision !== 'accepted' || decision.recommendation_version !== input.recommendationVersion) {
        return { status: 'failed_needs_attention', error: 'recommendation decision changed before execution', consequential: true }
      }

      const provenance = objectValue(rec.provenance)
      let plan
      try { plan = validateRecommendationActionPlan(provenance.actionPlan) }
      catch { return { status: 'failed_needs_attention', error: 'structured action plan is missing or no longer valid', consequential: true } }

      const authority = rec.required_authority as RecommendationAuthority
      const authorizationStillExists = await currentAuthority({
        workspaceId: input.workspaceId,
        authority,
        decisionActorKind: decision.actor_kind,
        decisionProvenance: objectValue(decision.authority_provenance),
      })
      const verdict = evaluateRecommendationDecisionPolicy({
        recommendation: {
          risk_classification: rec.risk_classification as RecommendationRisk,
          reversibility: rec.reversibility as RecommendationReversibility,
          required_authority: authority,
        },
        actionKind: actionKindForRecommendationPlan(plan),
        actionContext: actionContextForRecommendationPlan(plan, authorizationStillExists),
        workspacePolicy: workspacePolicyForRecommendationPlan(plan),
      })
      if (verdict.disposition === 'blocked') return { status: 'failed_needs_attention', error: `current action policy blocks execution: ${verdict.reasons.join(', ')}`, consequential: true }
      if (decision.actor_kind === 'system' && verdict.disposition !== 'auto_accept') {
        return { status: 'failed_needs_attention', error: `autonomous authority no longer permits execution: ${verdict.reasons.join(', ')}`, consequential: true }
      }
      if (decision.actor_kind !== 'system' && !authorizationStillExists) {
        return { status: 'failed_needs_attention', error: 'the authority that approved this recommendation is no longer current', consequential: true }
      }

      let tool
      try { tool = toolForRecommendationPlan(plan) }
      catch (error) { return { status: 'failed_needs_attention', error: error instanceof Error ? error.message : String(error), consequential: true } }

      const requestId = `recommendation:${input.recommendationId}:${input.recommendationVersion}:${input.decisionId ?? 'none'}`
      const orchestrated = await runToolWithRecovery(tool, plan.arguments, {
        workspaceId: input.workspaceId,
        callerRole: 'founder',
        operatorId: null,
        requestId,
        origin: 'scan',
      }, { mode: 'back-office', toolUseId: `recommendation:${input.recommendationId}` })
      const result = orchestrated.result
      if (result.ok) {
        return { status: 'completed', material: plan.materiality !== 'quiet', executionRef: `caye_tool_calls:${requestId}` }
      }
      if (result.status === 'FAILED_RETRYABLE') return { status: 'retryable_failure', error: result.error ?? 'registered capability failed retryably' }
      return {
        status: 'failed_needs_attention',
        error: result.error ?? `registered capability returned ${result.status ?? 'failure'}`,
        consequential: plan.materiality === 'consequential' || result.status === 'NEEDS_HUMAN',
      }
    },

    async setExecutionState(input) {
      const db = createServiceClient()
      const { data: decision, error } = await db
        .from('caye_recommendation_decisions')
        .select('id,authority_provenance,recommendation_version,decision')
        .eq('recommendation_id', input.recommendationId)
        .eq('workspace_id', input.workspaceId)
        .order('decided_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error || !decision || decision.decision !== 'accepted' || decision.recommendation_version !== input.recommendationVersion) return false
      const provenance = objectValue(decision.authority_provenance)
      const { error: updateError } = await db
        .from('caye_recommendation_decisions')
        .update({
          authority_provenance: {
            ...provenance,
            recommendationExecutionState: input.state,
            recommendationExecutionRef: input.executionRef ?? null,
            recommendationExecutionError: input.error ?? null,
            recommendationExecutionUpdatedAt: new Date().toISOString(),
          },
        })
        .eq('id', decision.id)
        .eq('recommendation_version', input.recommendationVersion)
        .eq('decision', 'accepted')
      return !updateError
    },

    async requireFailureAttention(input) {
      await observeAttentionItem({
        workspaceId: input.workspaceId,
        subjectType: 'recommendation_execution',
        subjectId: input.recommendationId,
        title: 'Recommendation action needs attention',
        priority: 'decision',
        nextAction: 'Review the failed recommendation action before any further attempt.',
        fingerprintParts: [input.recommendationId, input.error],
        blockedOnOperator: true,
        resolvableAutonomously: false,
      })
    },

    async surfaceMaterialCompletion() {
      // Direction reads the material completed state from the durable decision
      // projection. No new Founder Direct notification system is created here.
    },
  }
}
