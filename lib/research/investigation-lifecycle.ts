import 'server-only'

import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { queueResearchRun } from './runtime'

export type InvestigationMode = 'one_shot' | 'follow_until_resolved' | 'monitor'
export type InvestigationLifecycleStatus = 'active' | 'resolved' | 'paused'
export type InvestigationOrigin = 'canonical' | 'founder' | 'autonomous_signal' | 'autonomous_followup' | 'autonomous_cross_check'

type LifecycleQuestion = {
  id: string
  program_id?: string
  canonical_key?: string | null
  status?: string
  investigation_mode: InvestigationMode
  lifecycle_status: InvestigationLifecycleStatus
  investigation_origin?: InvestigationOrigin
  parent_question_id?: string | null
  root_question_id?: string | null
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  next_review_at: string | null
  refresh_interval_hours: number | null
  autonomous_run_count: number
  max_autonomous_runs: number
  max_autonomous_followups?: number
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

export type InvestigationFollowUp = {
  kind: 'autonomous_followup' | 'autonomous_cross_check'
  question: string
  sourceText: string
}

const MAX_CHILDREN_PER_ADVANCE = 2

function nonEmptyArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.filter((item) => {
    if (typeof item === 'string') return item.trim().length > 0
    return item !== null && item !== undefined
  }) : []
}

function sourceText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  try { return JSON.stringify(value) } catch { return String(value) }
}

function addHours(now: Date, hours: number): string {
  return new Date(now.getTime() + Math.max(1, hours) * 60 * 60 * 1000).toISOString()
}

export function investigationFollowUpCanonicalKey(rootId: string, child: InvestigationFollowUp): string {
  const digest = createHash('sha256').update(`${child.kind}\n${child.sourceText.trim().toLowerCase()}`).digest('hex').slice(0, 24)
  return `investigation:${rootId}:${child.kind}:${digest}`
}

export function planInvestigationFollowUps(brief: LatestBrief | null, limit = MAX_CHILDREN_PER_ADVANCE): InvestigationFollowUp[] {
  const cap = Math.max(0, Math.min(limit, MAX_CHILDREN_PER_ADVANCE))
  if (!cap) return []
  const conflicts = nonEmptyArray(brief?.conflicting_evidence).map(sourceText).filter(Boolean)
  const unknowns = nonEmptyArray(brief?.unknowns).map(sourceText).filter(Boolean)
  const candidates: InvestigationFollowUp[] = []
  const seen = new Set<string>()

  if (conflicts.length) {
    const contradiction = conflicts.slice(0, 3).join(' | ')
    candidates.push({
      kind: 'autonomous_cross_check',
      sourceText: contradiction,
      question: `Independently cross-check this contradiction using primary or high-quality sources not already relied on by the parent investigation. Determine which account is best supported and what remains uncertain: ${contradiction}`,
    })
    seen.add(`autonomous_cross_check:${contradiction.trim().toLowerCase()}`)
  }
  for (const unknown of unknowns) {
    if (candidates.length >= cap) break
    const dedupeKey = `autonomous_followup:${unknown.trim().toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    candidates.push({
      kind: 'autonomous_followup',
      sourceText: unknown,
      question: `Resolve this material unknown from the parent investigation with evidence: ${unknown}`,
    })
  }
  return candidates.slice(0, cap)
}

export function decideInvestigationLifecycle(args: { question: LifecycleQuestion; brief: LatestBrief | null; now?: Date }): LifecycleDecision {
  const { question, brief } = args
  const now = args.now ?? new Date()
  const runCount = question.autonomous_run_count + 1
  const conflicts = nonEmptyArray(brief?.conflicting_evidence)
  const unknowns = nonEmptyArray(brief?.unknowns)
  const materialChanges = nonEmptyArray(brief?.material_changes)
  const unresolved = conflicts.length > 0 || unknowns.length > 0
  const materialChanged = materialChanges.length > 0 || conflicts.length > 0
  const noChangeStreak = materialChanged ? 0 : question.no_change_streak + 1
  const baseHours = question.refresh_interval_hours ?? (question.investigation_mode === 'monitor' ? 24 : 6)

  if (question.investigation_mode === 'one_shot') {
    return {
      lifecycleStatus: unresolved ? 'paused' : 'resolved',
      nextReviewAt: null,
      runCount,
      noChangeStreak,
      materialChanged,
      reason: unresolved ? 'one_shot_incomplete_with_open_questions' : 'one_shot_complete',
    }
  }

  if (runCount >= question.max_autonomous_runs) {
    return { lifecycleStatus: 'paused', nextReviewAt: null, runCount, noChangeStreak, materialChanged, reason: 'autonomy_budget_exhausted' }
  }

  if (question.investigation_mode === 'follow_until_resolved') {
    if (!unresolved) {
      return { lifecycleStatus: 'resolved', nextReviewAt: null, runCount, noChangeStreak, materialChanged, reason: 'evidence_resolved' }
    }
    const reviewHours = conflicts.length > 0 ? Math.max(1, Math.min(6, Math.floor(baseHours / 2) || 1)) : baseHours
    return {
      lifecycleStatus: 'active',
      nextReviewAt: addHours(now, reviewHours),
      runCount,
      noChangeStreak,
      materialChanged,
      reason: conflicts.length > 0 ? 'contradictory_evidence_requires_recheck' : 'material_unknowns_remain',
    }
  }

  const multiplier = materialChanged ? 0.5 : Math.pow(2, Math.min(noChangeStreak, 4))
  const reviewHours = Math.max(1, Math.min(168, Math.round(baseHours * multiplier)))
  return {
    lifecycleStatus: 'active', nextReviewAt: addHours(now, reviewHours), runCount, noChangeStreak, materialChanged,
    reason: materialChanged ? 'monitor_material_change' : 'monitor_unchanged_backoff',
  }
}

export function canAdvanceResearchInvestigation(question: Pick<LifecycleQuestion, 'status' | 'lifecycle_status'>): boolean {
  return question.status !== 'archived' && question.lifecycle_status === 'active'
}

async function createBoundedFollowUps(question: LifecycleQuestion, brief: LatestBrief | null): Promise<number> {
  if (question.investigation_mode !== 'follow_until_resolved' || !question.program_id) return 0
  const rootId = question.root_question_id ?? question.id
  const rootCap = Math.max(0, Number(question.max_autonomous_followups ?? 6))
  if (!rootCap) return 0
  const db = createServiceClient()
  const { count, error: countError } = await db.from('research_questions')
    .select('id', { count: 'exact', head: true })
    .eq('root_question_id', rootId)
    .in('investigation_origin', ['autonomous_followup', 'autonomous_cross_check'])
  if (countError) throw countError
  const remaining = Math.max(0, rootCap - Number(count ?? 0))
  if (!remaining) return 0
  const candidates = planInvestigationFollowUps(brief, Math.min(remaining, MAX_CHILDREN_PER_ADVANCE))
  let queued = 0
  for (const child of candidates) {
    const inserted = await db.from('research_questions').insert({
      program_id: question.program_id,
      question: child.question,
      status: 'open',
      canonical_key: investigationFollowUpCanonicalKey(rootId, child),
      investigation_mode: 'one_shot',
      lifecycle_status: 'active',
      investigation_origin: child.kind,
      parent_question_id: question.id,
      root_question_id: rootId,
      priority: question.priority ?? 'normal',
      autonomous_run_count: 0,
      max_autonomous_runs: 1,
      max_autonomous_followups: 0,
      no_change_streak: 0,
    }).select('id').single()
    if (inserted.error?.code === '23505') continue
    if (inserted.error) throw inserted.error
    await queueResearchRun(inserted.data.id, child.kind === 'autonomous_cross_check' ? 'investigation_cross_check' : 'investigation_followup')
    queued += 1
  }
  return queued
}

export async function advanceResearchInvestigationLifecycle(questionId: string): Promise<LifecycleDecision | null> {
  const db = createServiceClient()
  const [questionResult, briefResult] = await Promise.all([
    db.from('research_questions')
      .select('id,program_id,canonical_key,status,investigation_mode,lifecycle_status,investigation_origin,parent_question_id,root_question_id,priority,next_review_at,refresh_interval_hours,autonomous_run_count,max_autonomous_runs,max_autonomous_followups,no_change_streak')
      .eq('id', questionId).maybeSingle(),
    db.from('research_briefs')
      .select('conflicting_evidence,unknowns,material_changes')
      .eq('question_id', questionId).order('revision', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (questionResult.error) throw questionResult.error
  if (briefResult.error) throw briefResult.error
  if (!questionResult.data || !canAdvanceResearchInvestigation(questionResult.data as LifecycleQuestion)) return null

  const question = questionResult.data as LifecycleQuestion
  const brief = (briefResult.data as LatestBrief | null) ?? null
  const decision = decideInvestigationLifecycle({ question, brief })
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
  }).eq('id', questionId).eq('lifecycle_status', 'active').neq('status', 'archived')
  if (update.error) throw update.error
  if (decision.lifecycleStatus === 'active') await createBoundedFollowUps(question, brief)
  return decision
}

export async function queueDueResearchInvestigations(limit = 3): Promise<number> {
  const db = createServiceClient()
  const now = new Date().toISOString()
  const { data, error } = await db.from('research_questions')
    .select('id,priority,next_review_at')
    .eq('lifecycle_status', 'active').neq('status', 'archived')
    .not('next_review_at', 'is', null).lte('next_review_at', now)
    .order('next_review_at', { ascending: true }).limit(Math.max(1, Math.min(limit, 5)))
  if (error) throw error
  let queued = 0
  for (const question of data ?? []) {
    await queueResearchRun(question.id, 'investigation_revisit')
    const cleared = await db.from('research_questions').update({ next_review_at: null })
      .eq('id', question.id).eq('lifecycle_status', 'active').neq('status', 'archived').lte('next_review_at', now)
    if (cleared.error) throw cleared.error
    queued += 1
  }
  return queued
}

export async function recordResearchInvestigationFailure(questionId: string): Promise<void> {
  const db = createServiceClient()
  const { data, error } = await db.from('research_questions')
    .select('id,status,investigation_mode,lifecycle_status,refresh_interval_hours,autonomous_run_count,max_autonomous_runs,no_change_streak')
    .eq('id', questionId).maybeSingle()
  if (error) throw error
  if (!data || !canAdvanceResearchInvestigation(data as LifecycleQuestion)) return
  const nextCount = Number(data.autonomous_run_count ?? 0) + 1
  const exhausted = nextCount >= Number(data.max_autonomous_runs ?? 8)
  const retryHours = Math.min(24, Math.max(2, Number(data.refresh_interval_hours ?? 6)))
  const update = await db.from('research_questions').update({
    autonomous_run_count: nextCount,
    last_run_at: new Date().toISOString(),
    lifecycle_status: exhausted ? 'paused' : 'active',
    next_review_at: exhausted ? null : addHours(new Date(), retryHours),
    resolution_reason: exhausted ? 'autonomy_budget_exhausted_after_failures' : 'research_run_failed_retry_scheduled',
  }).eq('id', questionId).eq('lifecycle_status', 'active').neq('status', 'archived')
  if (update.error) throw update.error
}
