import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type {
  ActivationCondition,
  CreateGoalInput,
  GoalDependencyRow,
  GoalMetricRow,
  GoalRow,
  GoalStatus,
  UpdateGoalInput,
} from './types'

/**
 * Data access for the goal/objective substrate. Every function that can
 * return workspace-scoped rows takes an explicit workspaceId and filters on
 * it — there is no "give me everything" query. Operator-scope (global,
 * workspace_id null) rows are only ever returned by the functions that say
 * so explicitly (listOperatorScopeGoals, listDirectionTree) — callers of
 * those MUST already be founder-authenticated (see app/api/founder/goals/*
 * routes, which call requireFounder before reaching this module). No
 * function here re-checks founder identity itself; this module is a data
 * layer, not an authorization layer — see lib/founder.ts for that boundary.
 */

interface GoalDbRow {
  id: string
  kind: string
  parent_id: string | null
  scope: string
  workspace_id: string | null
  title: string
  description: string | null
  status: string
  priority: string
  target_value: number | null
  current_value: number | null
  unit: string | null
  target_date: string | null
  confidence: number | null
  completion_criteria: string | null
  activation_conditions: ActivationCondition[] | null
  created_by_kind: string
  created_by_label: string | null
  created_by_user_id: string | null
  created_by_operator_id: number | null
  source: string | null
  rationale: string | null
  superseded_at: string | null
  superseded_by: string | null
  created_at: string
  updated_at: string
}

const GOAL_COLUMNS =
  'id, kind, parent_id, scope, workspace_id, title, description, status, priority, ' +
  'target_value, current_value, unit, target_date, confidence, completion_criteria, ' +
  'activation_conditions, created_by_kind, created_by_label, created_by_user_id, ' +
  'created_by_operator_id, source, rationale, superseded_at, superseded_by, created_at, updated_at'

function toGoalRow(row: GoalDbRow): GoalRow {
  return {
    id: row.id,
    kind: row.kind as GoalRow['kind'],
    parentId: row.parent_id,
    scope: row.scope as GoalRow['scope'],
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status as GoalStatus,
    priority: row.priority as GoalRow['priority'],
    targetValue: row.target_value,
    currentValue: row.current_value,
    unit: row.unit,
    targetDate: row.target_date,
    confidence: row.confidence,
    completionCriteria: row.completion_criteria,
    activationConditions: row.activation_conditions,
    createdByKind: row.created_by_kind as GoalRow['createdByKind'],
    createdByLabel: row.created_by_label,
    createdByUserId: row.created_by_user_id,
    createdByOperatorId: row.created_by_operator_id,
    source: row.source,
    rationale: row.rationale,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Every non-superseded goal belonging to exactly one workspace. Never
 *  returns operator-scope rows — the filter is structural (scope='workspace'
 *  AND workspace_id=id), not just a convention. */
export async function listWorkspaceGoals(workspaceId: string): Promise<GoalRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goals')
    .select(GOAL_COLUMNS)
    .eq('scope', 'workspace')
    .eq('workspace_id', workspaceId)
    .is('superseded_at', null)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[goals] listWorkspaceGoals failed:', error.message)
    return []
  }
  return ((data ?? []) as unknown as GoalDbRow[]).map(toGoalRow)
}

/** Founder-only: the operator's own cross-workspace direction (Vision,
 *  Business/Personal/Research domains, etc). Caller must already be
 *  founder-authenticated — see the module doc comment. */
export async function listOperatorScopeGoals(): Promise<GoalRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goals')
    .select(GOAL_COLUMNS)
    .eq('scope', 'operator')
    .is('superseded_at', null)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[goals] listOperatorScopeGoals failed:', error.message)
    return []
  }
  return ((data ?? []) as unknown as GoalDbRow[]).map(toGoalRow)
}

/**
 * Only what a proactive/heartbeat context should ever see: this workspace's
 * ACTIVE, actionable goals (status='active' AND not blocked by an
 * unsatisfied dependency), ordered by priority score. This is the function
 * lib/caye-agent/tools/read/list-active-goals.ts and the opportunity-scan
 * prompt builder call — never listWorkspaceGoals directly — so "future"
 * objectives (e.g. Research/Robotics) can never leak into what Caye treats
 * as current work just because they exist in the table.
 */
export async function listActiveEligibleGoals(workspaceId: string): Promise<GoalRow[]> {
  const all = await listWorkspaceGoals(workspaceId)
  const byId = new Map(all.map((g) => [g.id, g]))
  const active = all.filter((g) => g.status === 'active')
  const eligible: GoalRow[] = []
  for (const goal of active) {
    if (await isActionable(goal, byId)) eligible.push(goal)
  }
  return eligible
}

/**
 * A goal is actionable only if it is itself 'active' AND every declared
 * prerequisite (caye_goal_dependencies) is 'completed'. A 'blocked' or
 * 'paused' goal is never actionable regardless of dependencies. Accepts an
 * optional pre-fetched map of goals-by-id (from the same workspace query)
 * to avoid re-querying inside a loop; falls back to a direct lookup when a
 * dependency isn't in the map (cross-scope dependency, e.g. a workspace
 * goal depending on an operator-scope goal).
 */
export async function isActionable(goal: GoalRow, knownById?: Map<string, GoalRow>): Promise<boolean> {
  if (goal.status !== 'active') return false
  const deps = await listDependencies(goal.id)
  if (deps.length === 0) return true
  const supabase = createServiceClient()
  for (const dep of deps) {
    const known = knownById?.get(dep.dependsOnGoalId)
    if (known) {
      if (known.status !== 'completed') return false
      continue
    }
    const { data, error } = await supabase
      .from('caye_goals')
      .select('status')
      .eq('id', dep.dependsOnGoalId)
      .is('superseded_at', null)
      .maybeSingle()
    if (error || !data || (data as { status: string }).status !== 'completed') return false
  }
  return true
}

export async function listDependencies(goalId: string): Promise<GoalDependencyRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goal_dependencies')
    .select('id, goal_id, depends_on_goal_id, created_at')
    .eq('goal_id', goalId)
  if (error) {
    console.error('[goals] listDependencies failed:', error.message)
    return []
  }
  return ((data ?? []) as Array<{ id: number; goal_id: string; depends_on_goal_id: string; created_at: string }>).map(
    (r) => ({ id: r.id, goalId: r.goal_id, dependsOnGoalId: r.depends_on_goal_id, createdAt: r.created_at })
  )
}

export async function addDependency(goalId: string, dependsOnGoalId: string): Promise<{ ok: boolean; error?: string }> {
  if (goalId === dependsOnGoalId) return { ok: false, error: 'a goal cannot depend on itself' }
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('caye_goal_dependencies')
    .insert({ goal_id: goalId, depends_on_goal_id: dependsOnGoalId })
  if (error) {
    // Unique violation = already recorded, treat as idempotent success.
    if (error.code === '23505') return { ok: true }
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/** goalId's full ancestor chain (parent, grandparent, ...) up to a vision —
 *  the "why" trace the spec asks for ("send outreach -> improve acquisition
 *  -> $20k MRR -> economic independence -> vision"). Bounded to 20 hops as a
 *  cycle guard; parent_id assignment is application-controlled so a cycle
 *  should never occur, but this is a read path and must not hang. */
export async function resolveAncestorChain(goalId: string): Promise<GoalRow[]> {
  const supabase = createServiceClient()
  const chain: GoalRow[] = []
  let currentId: string | null = goalId
  const seen = new Set<string>()
  for (let i = 0; i < 20 && currentId && !seen.has(currentId); i++) {
    seen.add(currentId)
    const { data, error } = await supabase
      .from('caye_goals')
      .select(GOAL_COLUMNS)
      .eq('id', currentId)
      .maybeSingle()
    if (error || !data) break
    const row = toGoalRow(data as unknown as GoalDbRow)
    chain.push(row)
    currentId = row.parentId
  }
  // First entry is goalId itself; callers that want only ancestors slice(1).
  return chain
}

export async function getGoal(id: string): Promise<GoalRow | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goals')
    .select(GOAL_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  return toGoalRow(data as unknown as GoalDbRow)
}

export async function createGoal(input: CreateGoalInput): Promise<{ goal: GoalRow | null; error?: string }> {
  if (input.scope === 'workspace' && !input.workspaceId) {
    return { goal: null, error: 'workspaceId is required when scope is "workspace"' }
  }
  if (input.scope === 'operator' && input.workspaceId) {
    return { goal: null, error: 'workspaceId must not be set when scope is "operator"' }
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goals')
    .insert({
      kind: input.kind,
      parent_id: input.parentId ?? null,
      scope: input.scope,
      workspace_id: input.scope === 'workspace' ? input.workspaceId : null,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'future',
      priority: input.priority ?? 'medium',
      target_value: input.targetValue ?? null,
      current_value: input.currentValue ?? null,
      unit: input.unit ?? null,
      target_date: input.targetDate ?? null,
      confidence: input.confidence ?? null,
      completion_criteria: input.completionCriteria ?? null,
      activation_conditions: input.activationConditions ?? null,
      created_by_kind: input.createdByKind,
      created_by_label: input.createdByLabel ?? null,
      created_by_user_id: input.createdByUserId ?? null,
      created_by_operator_id: input.createdByOperatorId ?? null,
      source: input.source ?? null,
      rationale: input.rationale ?? null,
    })
    .select(GOAL_COLUMNS)
    .single()
  if (error || !data) return { goal: null, error: error?.message ?? 'insert failed' }
  return { goal: toGoalRow(data as unknown as GoalDbRow) }
}

export async function updateGoal(id: string, input: UpdateGoalInput): Promise<{ goal: GoalRow | null; error?: string }> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.title !== undefined) patch.title = input.title
  if (input.description !== undefined) patch.description = input.description
  if (input.status !== undefined) patch.status = input.status
  if (input.priority !== undefined) patch.priority = input.priority
  if (input.targetValue !== undefined) patch.target_value = input.targetValue
  if (input.currentValue !== undefined) patch.current_value = input.currentValue
  if (input.unit !== undefined) patch.unit = input.unit
  if (input.targetDate !== undefined) patch.target_date = input.targetDate
  if (input.confidence !== undefined) patch.confidence = input.confidence
  if (input.completionCriteria !== undefined) patch.completion_criteria = input.completionCriteria
  if (input.activationConditions !== undefined) patch.activation_conditions = input.activationConditions
  if (input.rationale !== undefined) patch.rationale = input.rationale

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goals')
    .update(patch)
    .eq('id', id)
    .is('superseded_at', null)
    .select(GOAL_COLUMNS)
    .single()
  if (error || !data) return { goal: null, error: error?.message ?? 'update failed (goal missing or already superseded)' }
  return { goal: toGoalRow(data as unknown as GoalDbRow) }
}

/**
 * Supersede an existing goal with a freshly-created replacement, inside one
 * transaction-equivalent pair of statements (mirrors business_facts'
 * superseded_at-first-then-insert ordering, minus the row-lock/RPC — see the
 * migration header for why goals don't need that here). The old row is
 * never deleted; superseded_by points forward once the new id exists.
 */
export async function supersedeGoal(
  id: string,
  replacement: CreateGoalInput
): Promise<{ goal: GoalRow | null; error?: string }> {
  const existing = await getGoal(id)
  if (!existing) return { goal: null, error: 'goal not found' }
  if (existing.supersededAt) return { goal: null, error: 'goal is already superseded' }

  const { goal: created, error: createError } = await createGoal(replacement)
  if (!created) return { goal: null, error: createError ?? 'failed to create replacement' }

  const supabase = createServiceClient()
  const { error: supersedeError } = await supabase
    .from('caye_goals')
    .update({ superseded_at: new Date().toISOString(), superseded_by: created.id, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('superseded_at', null)
  if (supersedeError) return { goal: created, error: `replacement created but supersede failed: ${supersedeError.message}` }
  return { goal: created }
}

export async function recordMetric(input: {
  goalId: string
  metricKey: string
  value: number
  unit?: string | null
  evidenceKind?: 'authoritative' | 'estimated'
  source: string
  evidenceRef?: string | null
  recordedBy?: string | null
  note?: string | null
  observedAt?: string
}): Promise<{ metric: GoalMetricRow | null; error?: string }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goal_metrics')
    .insert({
      goal_id: input.goalId,
      metric_key: input.metricKey,
      value: input.value,
      unit: input.unit ?? null,
      evidence_kind: input.evidenceKind ?? 'authoritative',
      source: input.source,
      evidence_ref: input.evidenceRef ?? null,
      recorded_by: input.recordedBy ?? null,
      note: input.note ?? null,
      observed_at: input.observedAt ?? new Date().toISOString(),
    })
    .select('id, goal_id, metric_key, value, unit, evidence_kind, source, evidence_ref, recorded_by, note, observed_at, created_at')
    .single()
  if (error || !data) return { metric: null, error: error?.message ?? 'insert failed' }
  const row = data as {
    id: number; goal_id: string; metric_key: string; value: number; unit: string | null
    evidence_kind: string; source: string; evidence_ref: string | null; recorded_by: string | null
    note: string | null; observed_at: string; created_at: string
  }
  return {
    metric: {
      id: row.id, goalId: row.goal_id, metricKey: row.metric_key, value: row.value, unit: row.unit,
      evidenceKind: row.evidence_kind as GoalMetricRow['evidenceKind'], source: row.source,
      evidenceRef: row.evidence_ref, recordedBy: row.recorded_by, note: row.note,
      observedAt: row.observed_at, createdAt: row.created_at,
    },
  }
}

export async function listMetrics(goalId: string, limit = 50): Promise<GoalMetricRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goal_metrics')
    .select('id, goal_id, metric_key, value, unit, evidence_kind, source, evidence_ref, recorded_by, note, observed_at, created_at')
    .eq('goal_id', goalId)
    .order('observed_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('[goals] listMetrics failed:', error.message)
    return []
  }
  return (
    (data ?? []) as Array<{
      id: number; goal_id: string; metric_key: string; value: number; unit: string | null
      evidence_kind: string; source: string; evidence_ref: string | null; recorded_by: string | null
      note: string | null; observed_at: string; created_at: string
    }>
  ).map((row) => ({
    id: row.id, goalId: row.goal_id, metricKey: row.metric_key, value: row.value, unit: row.unit,
    evidenceKind: row.evidence_kind as GoalMetricRow['evidenceKind'], source: row.source,
    evidenceRef: row.evidence_ref, recordedBy: row.recorded_by, note: row.note,
    observedAt: row.observed_at, createdAt: row.created_at,
  }))
}

/** Children of a goal (one level), non-superseded only. Used by the
 *  dashboard to render the hierarchy without fetching everything at once. */
export async function listChildren(parentId: string): Promise<GoalRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('caye_goals')
    .select(GOAL_COLUMNS)
    .eq('parent_id', parentId)
    .is('superseded_at', null)
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[goals] listChildren failed:', error.message)
    return []
  }
  return ((data ?? []) as unknown as GoalDbRow[]).map(toGoalRow)
}
