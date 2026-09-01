import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOperation } from '@/lib/pending-operations'
import { resolveWorkspaceDecisionAuthority } from '@/lib/decision-authority'
import { observeAttentionItem } from '@/lib/owner-attention'
import { decideRecommendationForExecution } from './decisions'
import {
  actionContextForRecommendationPlan,
  actionKindForRecommendationPlan,
  workspacePolicyForRecommendationPlan,
  validateRecommendationActionPlan,
  type RecommendationActionPlan,
} from './action-plan'
import { ensureRecommendationActionPlan } from './action-plan-production'
import type { RecommendationAuthority, RecommendationReversibility, RecommendationRisk } from './service'

export const RECOMMENDATION_WAKE_LIMIT = 5

export type RecommendationWakeDecision = 'pending' | 'accepted' | 'rejected' | 'deferred' | 'cancelled' | null
export type RecommendationExecutionState = 'approved_queued' | 'acting_now' | 'completed' | 'failed_needs_attention' | null

export type RecommendationWakeCandidate = {
  id: string
  workspaceId: string
  status: string
  version: string
  latestDecisionId: string | null
  latestDecision: RecommendationWakeDecision
  latestDecisionVersion: string | null
  executionState: RecommendationExecutionState
  actionPlan: RecommendationActionPlan | null
  riskClassification: RecommendationRisk
  reversibility: RecommendationReversibility
  requiredAuthority: RecommendationAuthority
}

export type RecommendationWakeSummary = {
  scanned: number
  queued: number
  alreadyQueued: number
  waitingForFounder: number
  terminal: number
  staleApproval: number
  noExecutablePlan: number
  failedToQueue: number
}

type DecisionOutcome =
  | { kind: 'accepted'; decisionId: string }
  | { kind: 'waiting' }
  | { kind: 'blocked' }

type WakeDeps = {
  listCandidates: (limit: number) => Promise<RecommendationWakeCandidate[]>
  enqueue: (candidate: RecommendationWakeCandidate) => Promise<{ queued: boolean; alreadyQueued: boolean }>
  decideUndecided?: (candidate: RecommendationWakeCandidate) => Promise<DecisionOutcome>
}

function executionStateFromProvenance(value: unknown): RecommendationExecutionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const raw = row.recommendationExecutionState ?? row.recommendation_execution_state ?? row.executionState ?? row.execution_state
  if (raw === 'approved_queued' || raw === 'acting_now' || raw === 'completed' || raw === 'failed_needs_attention') return raw
  if (raw === 'acting') return 'acting_now'
  return null
}

export function shouldWakeRecommendation(candidate: RecommendationWakeCandidate):
  | 'queue'
  | 'needs_decision'
  | 'waiting_for_founder'
  | 'terminal'
  | 'stale_approval'
  | 'no_plan' {
  if (!candidate.actionPlan) return 'no_plan'
  if (candidate.executionState === 'completed' || candidate.executionState === 'failed_needs_attention') return 'terminal'
  if (candidate.executionState === 'approved_queued' || candidate.executionState === 'acting_now') return 'terminal'
  if (candidate.latestDecision === 'rejected' || candidate.latestDecision === 'deferred' || candidate.latestDecision === 'cancelled') return 'terminal'
  if (candidate.latestDecision === 'pending') return 'waiting_for_founder'
  if (candidate.latestDecision === 'accepted' && candidate.latestDecisionVersion !== candidate.version) return 'stale_approval'
  if (candidate.latestDecision === null) return 'needs_decision'
  return 'queue'
}

export function recommendationWakeIdempotencyKey(candidate: RecommendationWakeCandidate): string {
  return ['recommendation_action', candidate.id, candidate.version, candidate.latestDecisionId ?? 'undecided'].join(':')
}

async function loadLatestDecision(db: ReturnType<typeof createServiceClient>, recommendationId: string) {
  const { data, error } = await db
    .from('caye_recommendation_decisions')
    .select('id,decision,recommendation_version,authority_provenance,decided_at,created_at')
    .eq('recommendation_id', recommendationId)
    .order('decided_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`recommendation decision wake scan failed: ${error.message}`)
  return data
}

async function listProductionCandidates(limit: number): Promise<RecommendationWakeCandidate[]> {
  const db = createServiceClient()
  const scanLimit = Math.max(limit, Math.min(limit * 4, 20))
  const recommendations = await db
    .from('caye_recommendations')
    .select('id,workspace_id,status,risk_classification,reversibility,required_authority,provenance')
    .not('workspace_id', 'is', null)
    .in('status', ['proposed', 'accepted'])
    .is('superseded_at', null)
    .order('updated_at', { ascending: true })
    .limit(scanLimit)
  if (recommendations.error) throw new Error(`recommendation wake scan failed: ${recommendations.error.message}`)

  const candidates: RecommendationWakeCandidate[] = []
  for (const row of recommendations.data ?? []) {
    if (candidates.length >= limit) break
    let plan: RecommendationActionPlan | null = null
    const provenance = row.provenance && typeof row.provenance === 'object' && !Array.isArray(row.provenance)
      ? row.provenance as Record<string, unknown>
      : {}
    if (provenance.actionPlan) {
      try { plan = validateRecommendationActionPlan(provenance.actionPlan) } catch { plan = null }
    } else {
      try { plan = await ensureRecommendationActionPlan(row.id) } catch (error) {
        console.error('[recommendation-worker] action plan proposal failed', row.id, error)
      }
    }

    const { data: version, error: versionError } = await db.rpc('caye_recommendation_version', { p_recommendation_id: row.id })
    if (versionError || typeof version !== 'string' || !version) {
      console.error('[recommendation-worker] version lookup failed', row.id, versionError?.message ?? 'missing version')
      continue
    }
    const decision = await loadLatestDecision(db, row.id)
    candidates.push({
      id: row.id,
      workspaceId: row.workspace_id!,
      status: row.status,
      version,
      latestDecisionId: decision?.id ?? null,
      latestDecision: (decision?.decision as RecommendationWakeDecision) ?? null,
      latestDecisionVersion: decision?.recommendation_version ?? null,
      executionState: executionStateFromProvenance(decision?.authority_provenance),
      actionPlan: plan,
      riskClassification: row.risk_classification as RecommendationRisk,
      reversibility: row.reversibility as RecommendationReversibility,
      requiredAuthority: row.required_authority as RecommendationAuthority,
    })
  }
  return candidates
}

async function currentAuthorityExists(candidate: RecommendationWakeCandidate): Promise<boolean> {
  const authority = candidate.requiredAuthority
  if (authority.principalType === 'personal') return false
  const required = authority.principalRef?.trim()
  if (!required || authority.resolvedBy !== 'canonical_authority') return false
  const resolution = await resolveWorkspaceDecisionAuthority({ workspaceId: candidate.workspaceId, requiredAuthority: required })
  return resolution.authorizedPrincipals.length > 0
}

async function waitForFounderPersonalDecision(candidate: RecommendationWakeCandidate): Promise<DecisionOutcome> {
  await observeAttentionItem({
    workspaceId: candidate.workspaceId,
    subjectType: 'recommendation_decision',
    subjectId: candidate.id,
    title: 'Recommendation needs founder judgment',
    priority: 'decision',
    nextAction: 'Review this recommendation in Direction, then approve, reject, or defer it.',
    fingerprintParts: [candidate.id, candidate.version, candidate.riskClassification, candidate.reversibility, JSON.stringify(candidate.requiredAuthority)],
    blockedOnOperator: true,
    resolvableAutonomously: false,
  })
  return { kind: 'waiting' }
}

async function decideProductionCandidate(candidate: RecommendationWakeCandidate): Promise<DecisionOutcome> {
  if (!candidate.actionPlan) return { kind: 'blocked' }
  if (candidate.requiredAuthority.principalType === 'personal') return waitForFounderPersonalDecision(candidate)

  const hasExistingAuthorization = await currentAuthorityExists(candidate)
  const result = await decideRecommendationForExecution({
    recommendationId: candidate.id,
    workspaceId: candidate.workspaceId,
    actionKind: actionKindForRecommendationPlan(candidate.actionPlan),
    actionContext: actionContextForRecommendationPlan(candidate.actionPlan, hasExistingAuthorization),
    workspacePolicy: workspacePolicyForRecommendationPlan(candidate.actionPlan),
    idempotencyKey: `recommendation-wake-decision:${candidate.id}:${candidate.version}`,
  })
  if (!result.executionEligible) return result.disposition === 'blocked' ? { kind: 'blocked' } : { kind: 'waiting' }
  const raw = Array.isArray(result.decision) ? result.decision[0] : result.decision
  return raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
    ? { kind: 'accepted', decisionId: (raw as { id: string }).id }
    : { kind: 'blocked' }
}

async function projectApprovedQueued(candidate: RecommendationWakeCandidate): Promise<void> {
  if (!candidate.latestDecisionId) return
  const db = createServiceClient()
  const { data: decision } = await db
    .from('caye_recommendation_decisions')
    .select('id,decision,recommendation_version,authority_provenance')
    .eq('id', candidate.latestDecisionId)
    .eq('recommendation_id', candidate.id)
    .eq('workspace_id', candidate.workspaceId)
    .maybeSingle()
  if (!decision || decision.decision !== 'accepted' || decision.recommendation_version !== candidate.version) return
  const provenance = decision.authority_provenance && typeof decision.authority_provenance === 'object' && !Array.isArray(decision.authority_provenance)
    ? decision.authority_provenance as Record<string, unknown>
    : {}
  await db
    .from('caye_recommendation_decisions')
    .update({
      authority_provenance: {
        ...provenance,
        recommendationExecutionState: 'approved_queued',
        recommendationAuthorityDisposition: 'granted',
        recommendationExecutionUpdatedAt: new Date().toISOString(),
      },
    })
    .eq('id', decision.id)
    .eq('decision', 'accepted')
    .eq('recommendation_version', candidate.version)
}

async function enqueueProductionCandidate(candidate: RecommendationWakeCandidate) {
  const result = await enqueueOperation({
    workspaceId: candidate.workspaceId,
    operation: 'recommendation_action',
    payload: { recommendation_id: candidate.id, recommendation_version: candidate.version, decision_id: candidate.latestDecisionId },
    idempotencyKey: recommendationWakeIdempotencyKey(candidate),
    delayMs: 0,
  })
  if (result.queued) await projectApprovedQueued(candidate)
  return result
}

/** Bounded wake pass. Prose never becomes executable input. */
export async function stageEligibleRecommendationActions(
  limit = RECOMMENDATION_WAKE_LIMIT,
  deps: WakeDeps = { listCandidates: listProductionCandidates, enqueue: enqueueProductionCandidate },
): Promise<RecommendationWakeSummary> {
  const boundedLimit = Math.max(0, Math.min(limit, RECOMMENDATION_WAKE_LIMIT))
  const candidates = boundedLimit === 0 ? [] : await deps.listCandidates(boundedLimit)
  const summary: RecommendationWakeSummary = { scanned: Math.min(candidates.length, boundedLimit), queued: 0, alreadyQueued: 0, waitingForFounder: 0, terminal: 0, staleApproval: 0, noExecutablePlan: 0, failedToQueue: 0 }

  for (const initial of candidates.slice(0, boundedLimit)) {
    let candidate = initial
    let disposition = shouldWakeRecommendation(candidate)
    if (disposition === 'no_plan') { summary.noExecutablePlan += 1; continue }
    if (disposition === 'waiting_for_founder') { summary.waitingForFounder += 1; continue }
    if (disposition === 'terminal') { summary.terminal += 1; continue }
    if (disposition === 'stale_approval') { summary.staleApproval += 1; continue }

    if (disposition === 'needs_decision') {
      const decision = await (deps.decideUndecided ?? decideProductionCandidate)(candidate)
      if (decision.kind === 'waiting') { summary.waitingForFounder += 1; continue }
      if (decision.kind === 'blocked') { summary.terminal += 1; continue }
      candidate = { ...candidate, status: 'accepted', latestDecision: 'accepted', latestDecisionId: decision.decisionId, latestDecisionVersion: candidate.version }
      disposition = 'queue'
    }

    if (disposition !== 'queue') continue
    const result = await deps.enqueue(candidate)
    if (!result.queued) summary.failedToQueue += 1
    else if (result.alreadyQueued) summary.alreadyQueued += 1
    else summary.queued += 1
  }
  return summary
}
