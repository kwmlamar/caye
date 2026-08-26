/**
 * GET  /api/founder/goals?workspaceId=<uuid optional>
 * POST /api/founder/goals
 *
 * Founder-only read/create surface for the goal substrate (see
 * lib/goals/*, supabase/migrations/20260826e_caye_goals_substrate.sql).
 * GET always returns the operator's cross-workspace direction (Vision +
 * Business/Personal/Research domains and objectives) — this route IS the
 * founder-authenticated boundary that scope requires; nothing else in the
 * codebase may read operator-scope goals. When workspaceId is supplied it
 * ALSO returns that one workspace's own goals, clearly separated so the
 * dashboard never has to guess which scope a row belongs to.
 *
 * POST creates a goal at either scope. createdByKind/createdByUserId are
 * always derived from the authenticated founder — never taken from the
 * request body — so provenance is real, not client-asserted.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS (lib/founder.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createGoal, listOperatorScopeGoals, listWorkspaceGoals } from '@/lib/goals/goals'
import type { CreateGoalInput, GoalKind, GoalPriority, GoalScope, GoalStatus } from '@/lib/goals/types'

const VALID_KINDS: GoalKind[] = ['vision', 'domain', 'objective', 'goal', 'initiative']
const VALID_SCOPES: GoalScope[] = ['operator', 'workspace']
const VALID_STATUSES: GoalStatus[] = ['active', 'future', 'blocked', 'paused', 'completed', 'abandoned']
const VALID_PRIORITIES: GoalPriority[] = ['low', 'medium', 'high', 'critical']

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')

  const [operatorGoals, workspaceGoals] = await Promise.all([
    listOperatorScopeGoals(),
    workspaceId ? listWorkspaceGoals(workspaceId) : Promise.resolve([]),
  ])

  return NextResponse.json({ operatorGoals, workspaceGoals })
}

export async function POST(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { kind, scope, workspaceId, title } = body as Record<string, unknown>
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as GoalKind)) {
    return NextResponse.json({ error: `kind must be one of ${VALID_KINDS.join(', ')}` }, { status: 400 })
  }
  if (typeof scope !== 'string' || !VALID_SCOPES.includes(scope as GoalScope)) {
    return NextResponse.json({ error: `scope must be one of ${VALID_SCOPES.join(', ')}` }, { status: 400 })
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }
  if (scope === 'workspace' && typeof workspaceId !== 'string') {
    return NextResponse.json({ error: 'workspaceId is required when scope is "workspace"' }, { status: 400 })
  }

  const status = typeof body.status === 'string' && VALID_STATUSES.includes(body.status as GoalStatus)
    ? (body.status as GoalStatus) : undefined
  const priority = typeof body.priority === 'string' && VALID_PRIORITIES.includes(body.priority as GoalPriority)
    ? (body.priority as GoalPriority) : undefined

  const input: CreateGoalInput = {
    kind: kind as GoalKind,
    scope: scope as GoalScope,
    workspaceId: scope === 'workspace' ? (workspaceId as string) : null,
    parentId: typeof body.parentId === 'string' ? body.parentId : null,
    title: title.trim(),
    description: typeof body.description === 'string' ? body.description : null,
    status,
    priority,
    targetValue: typeof body.targetValue === 'number' ? body.targetValue : null,
    currentValue: typeof body.currentValue === 'number' ? body.currentValue : null,
    unit: typeof body.unit === 'string' ? body.unit : null,
    targetDate: typeof body.targetDate === 'string' ? body.targetDate : null,
    confidence: typeof body.confidence === 'number' ? body.confidence : null,
    completionCriteria: typeof body.completionCriteria === 'string' ? body.completionCriteria : null,
    activationConditions: Array.isArray(body.activationConditions) ? body.activationConditions : null,
    createdByKind: 'founder',
    createdByUserId: user.id,
    createdByLabel: user.email ?? null,
    source: 'dashboard:direction',
    rationale: typeof body.rationale === 'string' ? body.rationale : null,
  }

  const { goal, error } = await createGoal(input)
  if (!goal) return NextResponse.json({ error: error ?? 'Failed to create goal' }, { status: 400 })
  return NextResponse.json({ goal }, { status: 201 })
}
