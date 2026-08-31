import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { queueResearchRun } from './runtime'

export type InvestigationMode = 'one_shot' | 'follow_until_resolved' | 'monitor'
export type InvestigationLifecycleStatus = 'active' | 'resolved' | 'paused'

type LifecycleQuestion = {
  id: string
  investigation_mode: InvestigationMode
  lifecycle_status: InvestigationLifecycleStatus
  next_review_at: string | null
  refresh_interval_hours: number | null
  autonomous_run_count: number
  max_autonomous_runs: number
  no_change_streak: number
}

type LatestBrief = {
  conflicting_evidence: unknown
  unknowns: unknown
  material_changes: unknown
}

export type LifecycleDecision = {
  lifecycleStatus: InvestigationLifecycleStatus
  nextReviewAt: string | null
  runCount: number
  noChangeStreak: number
  materialChanged: boolean
  reason: string
}

function nonEmptyArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.filter((item) => {
    if (typeof item === 'string') return item.trim().length > 0
    return item !== null && item !== undefined
  }) : []
}

function addHours(now: Date, hours: number): string {
  return new Date(now.getTime() + Math.max(1, hours) * 60 * 60 * 1000).toISOString()
}

/**
 * Deterministic lifecycle policy over the canonical research brief. The model
 * produces the evidence/brief; code decides whether Caye stops, revisits, backs
 * off, or pauses at the hard autonomy budget. No model can grant itself more
 * research budget by wording a recommendation persuasively.
 */
export function decideInvestigationLifecycle(args: {
  question: LifecycleQuestion
  brief: LatestBrief | null
  now?: Date
}): LifecycleDecision {
  const { question, brief } = args
  const now = args.now ?? new Date()
  const runCount = question.autonomous_run_count + 1
  const conflicts = nonEmptyArray(brief?.conflicting_evidence)
  const unknowns = nonEmptyArray(brief?.unknowns)
  const materialChanges = nonEmptyArray(brief?.material_changes)
  const unresolved = conflicts.length > 0 || unknowns.length > 0
  const materialChanged = materialChanges.length > 0 || conflicts.length > 0
  const baseHours = question.refresh_interval_hours ?? (question.investigation_mode === 'monitor' ? 24 : 6)

  if (question.investigation_mode === 'one_shot') {
    return {
      lifecycleStatus: 'resolved',
      nextReviewAt: null,
      runCount,
      noChangeStreak: materialChanged ? 0 : question.no_change_streak + 1,
      materialChanged,
      reason: unresolved ? 'one_shot_complete_with_open_questions' : 'one_shot_complete',
    }
  }

  if (runCount >= question.max_autonomous_runs) {
    return {
      lifecycleStatus: 'paused',
      nextReviewAt: null,
      runCount,
      noChangeStreak: materialChanged ? 0 : question.no_change_streak + 1,
      materialChanged,
      reason: 'autonomy_budget_exhausted',
    }
  }

  if (question.investigation_mode === 'follow_until_resolved') {
    if (!unresolved) {
      return {
        lifecycleStatus: 'resolved',
        nextReviewAt: null,
        runCount,
        noChangeStreak: materialChanged ? 0 : question.no_change_streak + 1,
        materialChanged,
        reason: 'evidence_resolved',
      }
    }

    // Contradictions get a faster independent re-check than ordinary unknowns.
    const reviewHours = conflicts.length > 0 ? Math.max(1, Math.min(6, Math.floor(baseHours / 2) || 1)) : baseHours
    return {
      lifecycleStatus: 'active',
      nextReviewAt: addHours(now, reviewHours),
      runCount,
      noChangeStreak: materialChanged ? 0 : question.no_change_streak + 1,
      materialChanged,
      reason: conflicts.length > 0 ? 'contradictory_evidence_requires_recheck' : 'material_unknowns_remain',
    }
  }

  // Monitor mode never polls at a fixed frantic cadence forever. Meaningful
  // change accelerates the next check; repeated no-change results back off to a
  // one-week ceiling while preserving the founder's standing monitoring intent.
  const noChangeStreak = materialChanged ? 0 : question.no_change_streak + 1
  const multiplier = materialChanged ? 0.5 : Math.pow(2, Math.min(noChangeStreak, 4))
  const reviewHours = Math.max(1, Math.min(168, Math.round(baseHours * multiplier)))
  return {
    lifecycleStatus: 'active',
    nextReviewAt: addHours(now, reviewHours),
    runCount,
    noChangeStreak,
    materialChanged,
    reason: materialChanged ? 'monitor_material_change' : 'monitor_unchanged_backoff',
  }
}

export async function advanceResearchInvestigationLifecycle(questionId: string): Promise<LifecycleDecision | null> {
  const db = createServiceClient()
  const [questionResult, briefResult] = await Promise.all([
    db.from('research_questions')
      .select('id,investigation_mode,lifecycle_status,next_review_at,refresh_interval_hours,autonomous_run_count,max_autonomous_runs,no_change_streak')
      .eq('id', questionId)
      .maybeSingle(),
    db.from('research_briefs')
      .select('conflicting_evidence,unknowns,material_changes')
      .eq('question_id', questionId)
      .order('revision', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  if (questionResult.error) throw questionResult.error
  if (briefResult.error) throw briefResult.error
  if (!questionResult.data || questionResult.data.lifecycle_status !== 'active') return null

  const decision = decideInvestigationLifecycle({
    question: questionResult.data as LifecycleQuestion,
    brief: (briefResult.data as LatestBrief | null) ?? null,
  })
  const now = new Date().toISOString()
  const update = await db.from('research_questions').update({
    lifecycle_status: decision.lifecycleStatus,
    next_review_at: decision.nextReviewAt,
    autonomous_run_count: decision.runCount,
    no_change_streak: decision.noChangeStreak,
    last_run_at: now,
    last_material_change_at: decision.materialChanged ? now : undefined,
    resolved_at: decision.lifecycleStatus === 'resolved' ? now : null,
    resolution_reason: decision.reason,
  }).eq('id', questionId).eq('lifecycle_status', 'active')
  if (update.error) throw update.error
  return decision
}

/**
 * Make a small number of due questions eligible for the existing queue. This is
 * called by the existing research worker, so autonomous revisits do not require a
 * second cron or queueing system. queueResearchRun already converges concurrent
 * attempts on the canonical active-run uniqueness constraint.
 */
export async function queueDueResearchInvestigations(limit = 3): Promise<number> {
  const db = createServiceClient()
  const now = new Date().toISOString()
  const { data, error } = await db.from('research_questions')
    .select('id,priority,next_review_at')
    .eq('lifecycle_status', 'active')
    .neq('status', 'archived')
    .not('next_review_at', 'is', null)
    .lte('next_review_at', now)
    .order('next_review_at', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 5)))
  if (error) throw error

  let queued = 0
  for (const question of data ?? []) {
    await queueResearchRun(question.id, 'investigation_revisit')
    const cleared = await db.from('research_questions')
      .update({ next_review_at: null })
      .eq('id', question.id)
      .lte('next_review_at', now)
    if (cleared.error) throw cleared.error
    queued += 1
  }
  return queued
}

export async function recordResearchInvestigationFailure(questionId: string): Promise<void> {
  const db = createServiceClient()
  const { data, error } = await db.from('research_questions')
    .select('id,investigation_mode,lifecycle_status,refresh_interval_hours,autonomous_run_count,max_autonomous_runs,no_change_streak')
    .eq('id', questionId)
    .maybeSingle()
  if (error) throw error
  if (!data || data.lifecycle_status !== 'active') return

  const nextCount = Number(data.autonomous_run_count ?? 0) + 1
  const exhausted = nextCount >= Number(data.max_autonomous_runs ?? 8)
  const retryHours = Math.min(24, Math.max(2, Number(data.refresh_interval_hours ?? 6)))
  const update = await db.from('research_questions').update({
    autonomous_run_count: nextCount,
    last_run_at: new Date().toISOString(),
    lifecycle_status: exhausted ? 'paused' : 'active',
    next_review_at: exhausted ? null : addHours(new Date(), retryHours),
    resolution_reason: exhausted ? 'autonomy_budget_exhausted_after_failures' : 'research_run_failed_retry_scheduled',
  }).eq('id', questionId).eq('lifecycle_status', 'active')
  if (update.error) throw update.error
}
