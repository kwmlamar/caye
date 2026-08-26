import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'
import type { GoalRow } from '@/lib/goals/types'

vi.mock('server-only', () => ({}))

function goal(overrides: Partial<GoalRow>): GoalRow {
  return {
    id: 'g1', kind: 'objective', parentId: null, scope: 'workspace', workspaceId: 'ws-a',
    title: 'x', description: null, status: 'active', priority: 'medium',
    targetValue: null, currentValue: null, unit: null, targetDate: null, confidence: null,
    completionCriteria: null, activationConditions: null,
    createdByKind: 'founder', createdByLabel: null, createdByUserId: null, createdByOperatorId: null,
    source: null, rationale: null, supersededAt: null, supersededBy: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

let goalsByWorkspace: Record<string, GoalRow[]> = {}
let requestedWorkspaceIds: string[] = []

vi.mock('@/lib/goals/goals', () => ({
  listActiveEligibleGoals: async (workspaceId: string) => {
    requestedWorkspaceIds.push(workspaceId)
    return goalsByWorkspace[workspaceId] ?? []
  },
}))

const { listActiveGoals } = await import('./list-active-goals')

beforeEach(() => {
  goalsByWorkspace = {}
  requestedWorkspaceIds = []
})

function ctx(workspaceId: string): ToolContext {
  return { workspaceId, callerRole: 'owner' } as unknown as ToolContext
}

describe('list_active_goals tool', () => {
  it('only ever queries this turn\'s own workspaceId — never a global/operator scope', async () => {
    goalsByWorkspace['ws-a'] = [goal({ id: 'g1', workspaceId: 'ws-a', title: 'Increase trial conversion' })]
    await listActiveGoals.execute({}, ctx('ws-a'))
    expect(requestedWorkspaceIds).toEqual(['ws-a'])
  })

  it("never returns another workspace's goals even when both have active goals", async () => {
    goalsByWorkspace['ws-a'] = [goal({ id: 'g-a', workspaceId: 'ws-a', title: 'Workspace A objective' })]
    goalsByWorkspace['ws-b'] = [goal({ id: 'g-b', workspaceId: 'ws-b', title: 'Workspace B objective' })]

    const result = await listActiveGoals.execute({}, ctx('ws-a'))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const titles = (result.data as { goals: Array<{ title: string }> }).goals.map((g) => g.title)
    expect(titles).toEqual(['Workspace A objective'])
  })

  it('does not expose parent ids or resolved lineage into workspace agent context', async () => {
    goalsByWorkspace['ws-a'] = [
      goal({
        id: 'workspace-goal',
        workspaceId: 'ws-a',
        parentId: 'operator-global-parent',
        title: 'Workspace objective',
      }),
    ]

    const result = await listActiveGoals.execute({}, ctx('ws-a'))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const [returned] = (result.data as { goals: Array<Record<string, unknown>> }).goals
    expect(returned).toBeDefined()
    expect(returned).not.toHaveProperty('parentId')
    expect(returned).not.toHaveProperty('parent_id')
    expect(returned).not.toHaveProperty('supports')
    expect(JSON.stringify(returned)).not.toContain('operator-global-parent')
  })

  it('returns a clean empty-state note when the workspace has no active goals', async () => {
    const result = await listActiveGoals.execute({}, ctx('ws-a'))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as { goals: unknown[]; note?: string }
    expect(data.goals).toEqual([])
    expect(data.note).toMatch(/no active goals/i)
  })

  it('is read-only and read-tier — declared risk is "read", not a write tier', () => {
    expect(listActiveGoals.risk).toBe('read')
  })

  it('is scoped to back-office only, not front-desk (customer-facing)', () => {
    expect(listActiveGoals.modes).toEqual(['back-office'])
  })
})
