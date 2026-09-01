import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOperation } from '@/lib/pending-operations'

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
}

export type RecommendationWakeSummary = {
  scanned: number
  queued: number
  alreadyQueued: number
  waitingForFounder: number
  terminal: number
  staleApproval: number
  failedToQueue: number
}

type WakeDeps = {
  listCandidates: (limit: number) => Promise<RecommendationWakeCandidate[]>
  enqueue: (candidate: RecommendationWakeCandidate) => Promise<{ queued: boolean; alreadyQueued: boolean }>
}

function executionStateFromProvenance(value: unknown): RecommendationExecutionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const raw = row.recommendationExecutionState ?? row.recommendation_execution_state ?? row.executionState ?? row.execution_state
  if (raw === 'approved_queued' || raw === 'acting_now' || raw === 'completed' || raw === 'failed_needs_attention') return raw
  return null
}

export function shouldWakeRecommendation(candidate: RecommendationWakeCandidate):
  | 'queue'
  | 'waiting_for_founder'
  | 'terminal'
  | 'stale_approval' {
  if (candidate.executionState === 'completed' || candidate.executionState === 'failed_needs_attention') return 'terminal'
  if (candidate.executionState === 'approved_queued' || candidate.executionState === 'acting_now') return 'terminal'

  if (candidate.latestDecision === 'rejected' || candidate.latestDecision === 'deferred' || candidate.latestDecision === 'cancelled') {
    return 'terminal'
  }
  if (candidate.latestDecision === 'pending') return 'waiting_for_founder'

  if (candidate.latestDecision === 'accepted' && candidate.latestDecisionVersion !== candidate.version) {
    return 'stale_approval'
  }

  return 'queue'
}

export function recommendationWakeIdempotencyKey(candidate: RecommendationWakeCandidate): string {
  return [
    'recommendation_action',
    candidate.id,
    candidate.version,
    candidate.latestDecisionId ?? 'undecided',
  ].join(':')
}

async function listProductionCandidates(limit: number): Promise<RecommendationWakeCandidate[]> {
  const db = createServiceClient()
  const scanLimit = Math.max(limit, Math.min(limit * 4, 20))
  const recommendations = await db
    .from('caye_recommendations')
    .select('id,workspace_id,status')
    .not('workspace_id', 'is', null)
    .in('status', ['proposed', 'accepted'])
    .is('superseded_at', null)
    .order('updated_at', { ascending: true })
    .limit(scanLimit)

  if (recommendations.error) throw new Error(`recommendation wake scan failed: ${recommendations.error.message}`)
  const rows = recommendations.data ?? []
  if (rows.length === 0) return []

  const ids = rows.map((row: any) => row.id)
  const decisions = await db
    .from('caye_recommendation_decisions')
    .select('id,recommendation_id,decision,recommendation_version,authority_provenance,decided_at,created_at')
    .in('recommendation_id', ids)
    .order('decided_at', { ascending: false })
    .order('created_at', { ascending: false })

  if (decisions.error) throw new Error(`recommendation decision wake scan failed: ${decisions.error.message}`)

  const latest = new Map<string, any>()
  for (const decision of decisions.data ?? []) {
    if (!latest.has((decision as any).recommendation_id)) latest.set((decision as any).recommendation_id, decision)
  }

  const candidates: RecommendationWakeCandidate[] = []
  for (const row of rows) {
    if (candidates.length >= limit) break
    const { data: version, error } = await db.rpc('caye_recommendation_version', { p_recommendation_id: (row as any).id })
    if (error || typeof version !== 'string' || !version) {
      console.error('[recommendation-worker] version lookup failed', (row as any).id, error?.message ?? 'missing version')
      continue
    }
    const decision = latest.get((row as any).id) ?? null
    candidates.push({
      id: (row as any).id,
      workspaceId: (row as any).workspace_id,
      status: (row as any).status,
      version,
      latestDecisionId: decision?.id ?? null,
      latestDecision: decision?.decision ?? null,
      latestDecisionVersion: decision?.recommendation_version ?? null,
      executionState: executionStateFromProvenance(decision?.authority_provenance),
    })
  }
  return candidates
}

async function enqueueProductionCandidate(candidate: RecommendationWakeCandidate) {
  return enqueueOperation({
    workspaceId: candidate.workspaceId,
    operation: 'recommendation_action',
    payload: {
      recommendation_id: candidate.id,
      recommendation_version: candidate.version,
      decision_id: candidate.latestDecisionId,
    },
    idempotencyKey: recommendationWakeIdempotencyKey(candidate),
    delayMs: 0,
  })
}

/**
 * Bounded wake pass for canonical recommendations. This function deliberately
 * knows nothing about model prose or action-plan arguments. The durable queued
 * operation carries only identity/version pins; the execution bridge must reload
 * and revalidate the canonical action plan, recommendation version, and current
 * authority immediately before any effect.
 */
export async function stageEligibleRecommendationActions(
  limit = RECOMMENDATION_WAKE_LIMIT,
  deps: WakeDeps = { listCandidates: listProductionCandidates, enqueue: enqueueProductionCandidate },
): Promise<RecommendationWakeSummary> {
  const boundedLimit = Math.max(0, Math.min(limit, RECOMMENDATION_WAKE_LIMIT))
  const candidates = boundedLimit === 0 ? [] : await deps.listCandidates(boundedLimit)
  const summary: RecommendationWakeSummary = {
    scanned: candidates.length,
    queued: 0,
    alreadyQueued: 0,
    waitingForFounder: 0,
    terminal: 0,
    staleApproval: 0,
    failedToQueue: 0,
  }

  for (const candidate of candidates.slice(0, boundedLimit)) {
    const disposition = shouldWakeRecommendation(candidate)
    if (disposition === 'waiting_for_founder') {
      summary.waitingForFounder += 1
      continue
    }
    if (disposition === 'terminal') {
      summary.terminal += 1
      continue
    }
    if (disposition === 'stale_approval') {
      summary.staleApproval += 1
      continue
    }

    const result = await deps.enqueue(candidate)
    if (!result.queued) {
      summary.failedToQueue += 1
    } else if (result.alreadyQueued) {
      summary.alreadyQueued += 1
    } else {
      summary.queued += 1
    }
  }
  return summary
}
