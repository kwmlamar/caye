import { describe, it, expect } from 'vitest'
import { makeGetJobLabor } from './get-job-labor'
import {
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockProject,
  type BedrockProjectLabor,
  type BedrockWorker,
} from '@/lib/domain-adapters/bedrock'
import type { ToolContext } from '../types'

const ctx: ToolContext = {
  workspaceId: 'ws-1',
  callerRole: 'owner',
  requestId: 'req-1',
}

function project(overrides: Partial<BedrockProject> = {}): BedrockProject {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'project',
    sourceEntityId: 'project-1',
    workspaceId: 'ws-1',
    companyId: 'company-1',
    id: 'project-1',
    name: 'Capricorn Pool',
    description: null,
    status: 'active',
    location: null,
    clientId: 'client-1',
    clientNameSnapshot: 'Capricorn',
    startDate: null,
    estimatedEndDate: null,
    budget: null,
    contractValue: null,
    ...overrides,
  }
}

function labor(overrides: Partial<BedrockProjectLabor> = {}): BedrockProjectLabor {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'project_labor',
    sourceEntityId: 'project-1',
    workspaceId: 'ws-1',
    companyId: 'company-1',
    id: 'project-1',
    projectId: 'project-1',
    regularHours: 40,
    overtimeHours: 4,
    totalHours: 44,
    entryCount: 6,
    workers: [
      { workerId: 'worker-1', workerName: 'Ada Builder', regularHours: 24, overtimeHours: 4, totalHours: 28 },
      { workerId: 'worker-2', workerName: 'Cyril Rolle', regularHours: 16, overtimeHours: 0, totalHours: 16 },
    ],
    ...overrides,
  }
}

function worker(overrides: Partial<BedrockWorker> = {}): BedrockWorker {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'worker',
    sourceEntityId: 'worker-1',
    workspaceId: 'ws-1',
    companyId: 'company-1',
    id: 'worker-1',
    firstName: 'Ada',
    lastName: 'Builder',
    status: 'active',
    workerType: 'employee',
    hourlyRate: 25,
    ...overrides,
  }
}

describe('getJobLabor', () => {
  it('resolves by project_id and returns the hours breakdown as all-time when no range is requested', async () => {
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => {
        throw new Error('should not search when project_id is given')
      },
      getProjectLabor: async (workspaceId, projectId) => {
        expect(workspaceId).toBe('ws-1')
        expect(projectId).toBe('project-1')
        return labor()
      },
      getWorker: async (_workspaceId, id) =>
        id === 'worker-1' ? worker({ id: 'worker-1', hourlyRate: 25 }) : worker({ id: 'worker-2', hourlyRate: 20 }),
    }))

    const result = await tool.execute({ project_id: 'project-1' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.regular_hours).toBe(40)
    expect(data.overtime_hours).toBe(4)
    expect(data.total_hours).toBe(44)
    expect(data.entry_count).toBe(6)
    expect(data.date_range).toMatchObject({ requested: null, applied: false })
    expect(data.rates_available).toBe(true)
    expect(data.total_labor_cost).toBe(28 * 25 + 16 * 20)
    expect(data.workers).toEqual(
      expect.arrayContaining([expect.objectContaining({ worker_id: 'worker-1', hourly_rate: 25, labor_cost: 700 })])
    )
  })

  it('resolves an unambiguous project_name via findProjects', async () => {
    let searched: string | undefined
    const tool = makeGetJobLabor(() => ({
      findProjects: async (_workspaceId, search) => {
        searched = search
        return [project({ id: 'project-1', name: 'Capricorn Pool' })]
      },
      getProjectLabor: async () => labor(),
      getWorker: async (_workspaceId, id) => worker({ id }),
    }))

    const result = await tool.execute({ project_name: 'Capricorn' }, ctx)
    expect(searched).toBe('Capricorn')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as any).project).toEqual({ id: 'project-1', name: 'Capricorn Pool' })
  })

  it('returns ambiguous candidates and does not guess when project_name matches more than one project', async () => {
    let laborCalled = false
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [
        project({ id: 'project-1', name: 'Christiansen Cistern' }),
        project({ id: 'project-2', name: 'Christiansen Renovation' }),
      ],
      getProjectLabor: async () => {
        laborCalled = true
        return labor()
      },
      getWorker: async (_w, id) => worker({ id }),
    }))

    const result = await tool.execute({ project_name: 'Christiansen' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.resolution).toBe('ambiguous')
    expect(data.candidates).toHaveLength(2)
    expect(data.candidates.map((c: any) => c.id)).toEqual(['project-1', 'project-2'])
    expect(laborCalled).toBe(false)
  })

  it('returns a clean not-found error when project_name matches nothing', async () => {
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [],
      getProjectLabor: async () => labor(),
      getWorker: async (_w, id) => worker({ id }),
    }))

    const result = await tool.execute({ project_name: 'Nowhere Job' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('NOT_FOUND')
  })

  it('returns a clean error (not a throw) when the workspace has no TropiTrack connection', async () => {
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [],
      getProjectLabor: async () => {
        throw new BedrockConnectionMissingError('ws-1')
      },
      getWorker: async (_w, id) => worker({ id }),
    }))

    const result = await tool.execute({ project_id: 'project-1' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('FAILED_PERMANENT')
    expect(result.error).toMatch(/no TropiTrack/i)
  })

  it('returns a clean not-found error when project_id does not exist in TropiTrack', async () => {
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [],
      getProjectLabor: async () => {
        throw new BedrockNotFoundError('project', 'bogus-id')
      },
      getWorker: async (_w, id) => worker({ id }),
    }))

    const result = await tool.execute({ project_id: 'bogus-id' }, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('NOT_FOUND')
  })

  it('labels the response as an unapplied date range when start_date/end_date are supplied, without silently dropping them', async () => {
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [],
      getProjectLabor: async () => labor(),
      getWorker: async (_w, id) => worker({ id }),
    }))

    const result = await tool.execute(
      { project_id: 'project-1', start_date: '2026-08-01', end_date: '2026-08-31' },
      ctx
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.date_range.applied).toBe(false)
    expect(data.date_range.requested).toEqual({ start_date: '2026-08-01', end_date: '2026-08-31' })
    expect(data.date_range.note).toMatch(/all-time/i)
    // Figures are still the full, unfiltered totals.
    expect(data.total_hours).toBe(44)
  })

  it('marks rates_available false and total_labor_cost null when any worker is missing an hourly rate', async () => {
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [],
      getProjectLabor: async () => labor(),
      getWorker: async (_w, id) =>
        id === 'worker-1' ? worker({ id: 'worker-1', hourlyRate: 25 }) : worker({ id: 'worker-2', hourlyRate: null }),
    }))

    const result = await tool.execute({ project_id: 'project-1' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.rates_available).toBe(false)
    expect(data.total_labor_cost).toBeNull()
  })

  it('rejects malformed date input before calling the adapter', async () => {
    let called = false
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [],
      getProjectLabor: async () => {
        called = true
        return labor()
      },
      getWorker: async (_w, id) => worker({ id }),
    }))

    const result = await tool.execute({ project_id: 'project-1', start_date: 'last week' }, ctx)
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })

  it('requires project_id or project_name', async () => {
    const tool = makeGetJobLabor(() => ({
      findProjects: async () => [],
      getProjectLabor: async () => labor(),
      getWorker: async (_w, id) => worker({ id }),
    }))
    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(false)
  })
})
