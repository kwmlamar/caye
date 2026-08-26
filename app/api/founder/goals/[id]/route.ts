/**
 * GET   /api/founder/goals/:id — one goal with its dependencies, recent
 *        metrics, and ancestor chain (the "why" trace).
 * PATCH /api/founder/goals/:id — update fields/status/priority, OR (when
 *        the body includes `supersede: true` + `replacement`) retire this
 *        goal and create its replacement in one call. Supersession is kept
 *        inside PATCH rather than a silent field mutation of `status` to
 *        'abandoned' — flipping status alone would lose the "this specific
 *        row was replaced by that specific row" link supersededAt/By exist
 *        to preserve.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS (lib/founder.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import {
  getGoal,
  listChildren,
  listDependencies,
  listMetrics,
  resolveAncestorChain,
  supersedeGoal,
  updateGoal,
} from '@/lib/goals/goals'
import { evaluateActivationEligibility } from '@/lib/goals/eligibility'
import type { CreateGoalInput, GoalPriority, GoalStatus, UpdateGoalInput } from '@/lib/goals/types'

const VALID_STATUSES: GoalStatus[] = ['active', 'future', 'blocked', 'paused', 'completed', 'abandoned']
const VALID_PRIORITIES: GoalPriority[] = ['low', 'medium', 'high', 'critical']

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const goal = await getGoal(id)
  if (!goal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [chain, dependencies, metrics, children, eligibility] = await Promise.all([
    resolveAncestorChain(id),
    listDependencies(id),
    listMetrics(id, 30),
    listChildren(id),
    evaluateActivationEligibility(goal),
  ])

  return NextResponse.json({
    goal,
    ancestors: chain.slice(1),
    dependencies,
    metrics,
    children,
    eligibility,
  })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (body.supersede === true) {
    const replacement = body.replacement
    if (!replacement || typeof replacement !== 'object') {
      return NextResponse.json({ error: 'replacement is required when supersede is true' }, { status: 400 })
    }
    const existing = await getGoal(id)
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const input: CreateGoalInput = {
      kind: existing.kind,
      scope: existing.scope,
      workspaceId: existing.workspaceId,
      parentId: existing.parentId,
      title: typeof replacement.title === 'string' ? replacement.title : existing.title,
      description: typeof replacement.description === 'string' ? replacement.description : existing.description,
      status: typeof replacement.status === 'string' && VALID_STATUSES.includes(replacement.status) ? replacement.status : 'active',
      priority: typeof replacement.priority === 'string' && VALID_PRIORITIES.includes(replacement.priority) ? replacement.priority : existing.priority,
      targetValue: typeof replacement.targetValue === 'number' ? replacement.targetValue : existing.targetValue,
      currentValue: typeof replacement.currentValue === 'number' ? replacement.currentValue : existing.currentValue,
      unit: typeof replacement.unit === 'string' ? replacement.unit : existing.unit,
      targetDate: typeof replacement.targetDate === 'string' ? replacement.targetDate : existing.targetDate,
      confidence: typeof replacement.confidence === 'number' ? replacement.confidence : existing.confidence,
      completionCriteria: typeof replacement.completionCriteria === 'string' ? replacement.completionCriteria : existing.completionCriteria,
      activationConditions: existing.activationConditions,
      createdByKind: 'founder',
      createdByUserId: user.id,
      source: 'dashboard:direction:supersede',
      rationale: typeof replacement.rationale === 'string' ? replacement.rationale : `Supersedes "${existing.title}"`,
    }
    const { goal, error } = await supersedeGoal(id, input)
    if (!goal) return NextResponse.json({ error: error ?? 'Failed to supersede goal' }, { status: 400 })
    return NextResponse.json({ goal })
  }

  const patch: UpdateGoalInput = {}
  if (typeof body.title === 'string') patch.title = body.title
  if (typeof body.description === 'string' || body.description === null) patch.description = body.description
  if (typeof body.status === 'string' && VALID_STATUSES.includes(body.status)) patch.status = body.status
  if (typeof body.priority === 'string' && VALID_PRIORITIES.includes(body.priority)) patch.priority = body.priority
  if (typeof body.targetValue === 'number' || body.targetValue === null) patch.targetValue = body.targetValue
  if (typeof body.currentValue === 'number' || body.currentValue === null) patch.currentValue = body.currentValue
  if (typeof body.unit === 'string' || body.unit === null) patch.unit = body.unit
  if (typeof body.targetDate === 'string' || body.targetDate === null) patch.targetDate = body.targetDate
  if (typeof body.confidence === 'number' || body.confidence === null) patch.confidence = body.confidence
  if (typeof body.completionCriteria === 'string' || body.completionCriteria === null) patch.completionCriteria = body.completionCriteria
  if (typeof body.rationale === 'string' || body.rationale === null) patch.rationale = body.rationale

  const { goal, error } = await updateGoal(id, patch)
  if (!goal) return NextResponse.json({ error: error ?? 'Failed to update goal' }, { status: 400 })
  return NextResponse.json({ goal })
}
