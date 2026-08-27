/**
 * Shared types for the goal/objective substrate. See
 * supabase/migrations/20260826e_caye_goals_substrate.sql for the schema
 * this mirrors, and lib/goals/goals.ts for the data-access contract.
 *
 * Goals are NOT memory (business_facts/standing_rules). A goal explains WHY
 * Caye is working on something and carries status/priority/prerequisites/
 * activation/supersession; it never grants authority to act — the existing
 * authority/confirmation architecture (lib/caye-agent/tools/high-risk-gate.ts)
 * is untouched by this module.
 */
import 'server-only'

export type GoalKind = 'vision' | 'domain' | 'objective' | 'goal' | 'initiative'

export type GoalStatus = 'active' | 'future' | 'blocked' | 'paused' | 'completed' | 'abandoned'

export type GoalPriority = 'low' | 'medium' | 'high' | 'critical'

export type GoalScope = 'operator' | 'workspace'

export type GoalCreatedByKind = 'founder' | 'owner' | 'operator' | 'system' | 'caye_proposed'

export type GoalEvidenceKind = 'authoritative' | 'estimated'

export interface ActivationCondition {
  metric_key: string
  comparator: '>=' | '<=' | '>' | '<' | '=='
  threshold: number
  /** Optional: condition must hold for this many consecutive days of the
   *  latest recorded metric to count as sustained. Advisory only — nothing
   *  auto-evaluates a rolling window today; see lib/goals/eligibility.ts. */
  sustained_days?: number
  note?: string
}

export interface GoalRow {
  id: string
  kind: GoalKind
  parentId: string | null
  scope: GoalScope
  workspaceId: string | null
  title: string
  description: string | null
  status: GoalStatus
  priority: GoalPriority
  targetValue: number | null
  currentValue: number | null
  unit: string | null
  targetDate: string | null
  confidence: number | null
  completionCriteria: string | null
  activationConditions: ActivationCondition[] | null
  createdByKind: GoalCreatedByKind
  createdByLabel: string | null
  createdByUserId: string | null
  createdByOperatorId: number | null
  source: string | null
  rationale: string | null
  supersededAt: string | null
  supersededBy: string | null
  createdAt: string
  updatedAt: string
}

export interface GoalMetricRow {
  id: number
  goalId: string
  metricKey: string
  value: number
  unit: string | null
  evidenceKind: GoalEvidenceKind
  source: string
  evidenceRef: string | null
  recordedBy: string | null
  note: string | null
  observedAt: string
  createdAt: string
}

export interface GoalDependencyRow {
  id: number
  goalId: string
  dependsOnGoalId: string
  createdAt: string
}

export interface CreateGoalInput {
  kind: GoalKind
  parentId?: string | null
  scope: GoalScope
  workspaceId?: string | null
  title: string
  description?: string | null
  status?: GoalStatus
  priority?: GoalPriority
  targetValue?: number | null
  currentValue?: number | null
  unit?: string | null
  targetDate?: string | null
  confidence?: number | null
  completionCriteria?: string | null
  activationConditions?: ActivationCondition[] | null
  createdByKind: GoalCreatedByKind
  createdByLabel?: string | null
  createdByUserId?: string | null
  createdByOperatorId?: number | null
  source?: string | null
  rationale?: string | null
}

export interface UpdateGoalInput {
  title?: string
  description?: string | null
  status?: GoalStatus
  priority?: GoalPriority
  targetValue?: number | null
  currentValue?: number | null
  unit?: string | null
  targetDate?: string | null
  confidence?: number | null
  completionCriteria?: string | null
  activationConditions?: ActivationCondition[] | null
  rationale?: string | null
}
