import { describe, it, expect } from 'vitest'
import { BedrockConnectionMissingError, type BedrockProject } from '@/lib/domain-adapters/bedrock'
import type { ToolContext } from '../types'
import { findJob, makeFindJob, resolveJob, type JobSearchAdapter } from './find-job'

const WORKSPACE = 'ws-ods'

function project(overrides: Partial<BedrockProject> & { id: string; name: string }): BedrockProject {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'project',
    sourceEntityId: overrides.id,
    workspaceId: WORKSPACE,
    companyId: 'ods-co',
    description: null,
    status: 'active',
    location: null,
    clientId: null,
    clientNameSnapshot: null,
    startDate: null,
    estimatedEndDate: null,
    budget: null,
    contractValue: null,
    ...overrides,
  }
}

// Realistic ODS fixtures from the operating-surface brief's informal-name table.
const PROJECTS: BedrockProject[] = [
  project({
    id: 'proj-blue-sky',
    name: 'Blue Sky Villa — Great Room Flooring',
    status: 'active',
    clientNameSnapshot: 'Eric Mann',
    location: 'Blue Sky Villa',
  }),
  project({
    id: 'proj-governors-harbour',
    name: "2026 Site Improvements — Governor's Harbour (Rev. 2)",
    status: 'active',
    clientNameSnapshot: 'Christiansen',
    location: "Snook, Governor's Harbour",
  }),
  project({
    id: 'proj-twin-coves',
    name: 'Twin Coves Beach, Lot#27',
    status: 'active',
    clientNameSnapshot: 'Wockenfuss',
    location: 'Twin Coves',
  }),
  project({
    id: 'proj-parks-1',
    name: 'Parks Residence — Kitchen Remodel',
    status: 'active',
    clientNameSnapshot: 'Mr. Richard Parks',
    location: 'Nassau',
  }),
  project({
    id: 'proj-parks-2',
    name: 'Parks Guest Cottage',
    status: 'active',
    clientNameSnapshot: 'Mr. Richard Parks',
    location: 'Nassau',
  }),
  project({
    id: 'proj-parks-3',
    name: 'Parks Dock Repair',
    status: 'planning',
    clientNameSnapshot: 'Mr. Richard Parks',
    location: 'Nassau',
  }),
  project({
    id: 'proj-parks-4-done',
    name: 'Parks Seawall',
    status: 'completed',
    clientNameSnapshot: 'Mr. Richard Parks',
    location: 'Nassau',
  }),
  project({
    id: 'proj-marina',
    name: 'Marina Refit',
    status: 'completed',
    clientNameSnapshot: 'Old Client',
    location: 'Marsh Harbour',
  }),
]

function fakeAdapter(rows: BedrockProject[] = PROJECTS): JobSearchAdapter {
  return {
    listProjects: async (workspaceId) => (workspaceId === WORKSPACE ? rows : []),
  }
}

function ctx(): ToolContext {
  return { workspaceId: WORKSPACE, callerRole: 'owner' } as unknown as ToolContext
}

describe('resolveJob', () => {
  it('resolves an exact-ish project-name query to a single candidate', async () => {
    const resolution = await resolveJob(fakeAdapter(), WORKSPACE, 'Blue Sky', false)
    expect(resolution.match).toBe('one')
    expect(resolution.candidates).toEqual([
      { id: 'proj-blue-sky', name: 'Blue Sky Villa — Great Room Flooring', status: 'active', client_name: 'Eric Mann', location: 'Blue Sky Villa' },
    ])
  })

  it('resolves a client-name nickname wrapped in filler words ("the Mann job") to the same project name-search would miss', async () => {
    const resolution = await resolveJob(fakeAdapter(), WORKSPACE, 'the Mann job', false)
    expect(resolution.match).toBe('one')
    expect(resolution.candidates[0].id).toBe('proj-blue-sky')
  })

  it('resolves a location-led query ("Snook") that never appears in the project name', async () => {
    const resolution = await resolveJob(fakeAdapter(), WORKSPACE, 'Snook', false)
    expect(resolution.match).toBe('one')
    expect(resolution.candidates[0].id).toBe('proj-governors-harbour')
  })

  it('returns ALL candidates for an ambiguous client with several concurrent jobs, and does not pick one', async () => {
    const resolution = await resolveJob(fakeAdapter(), WORKSPACE, 'Parks', false)
    expect(resolution.match).toBe('many')
    expect(resolution.count).toBe(3) // active/planning only by default — the completed Parks Seawall is excluded
    const ids = resolution.candidates.map((c) => c.id).sort()
    expect(ids).toEqual(['proj-parks-1', 'proj-parks-2', 'proj-parks-3'])
  })

  it('includes completed projects in the ambiguous set when include_completed is set', async () => {
    const resolution = await resolveJob(fakeAdapter(), WORKSPACE, 'Parks', true)
    expect(resolution.match).toBe('many')
    expect(resolution.count).toBe(4)
  })

  it('returns match "none" with an empty candidate list when nothing matches', async () => {
    const resolution = await resolveJob(fakeAdapter(), WORKSPACE, 'Nonexistent Client Nobody Has Heard Of', false)
    expect(resolution).toEqual({ match: 'none', count: 0, candidates: [] })
  })

  it('excludes completed projects by default even on an otherwise exact name match', async () => {
    const resolution = await resolveJob(fakeAdapter(), WORKSPACE, 'Marina Refit', false)
    expect(resolution.match).toBe('none')
  })
})

describe('find_job tool', () => {
  it('reports match, count, and full candidate detail (id, name, status, client_name, location) for an ambiguous result', async () => {
    const findJob = makeFindJob(() => fakeAdapter())
    const result = await findJob.execute({ query: 'Parks' }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as { match: string; count: number; candidates: Array<Record<string, unknown>> }
    expect(data.match).toBe('many')
    expect(data.count).toBe(3)
    for (const candidate of data.candidates) {
      expect(candidate).toHaveProperty('id')
      expect(candidate).toHaveProperty('name')
      expect(candidate).toHaveProperty('status')
      expect(candidate).toHaveProperty('client_name')
      expect(candidate).toHaveProperty('location')
    }
  })

  it('returns a clean ok:false error (never throws) when the workspace has no Bedrock connection', async () => {
    const findJob = makeFindJob(() => ({
      listProjects: async () => {
        throw new BedrockConnectionMissingError(WORKSPACE)
      },
    }))

    const result = await findJob.execute({ query: 'Blue Sky' }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/construction ledger/i)
    expect(result.error).not.toMatch(/BedrockConnectionMissingError/)
  })

  it('rejects an empty query without calling the adapter', async () => {
    let called = false
    const findJob = makeFindJob(() => ({
      listProjects: async () => {
        called = true
        return []
      },
    }))

    const result = await findJob.execute({ query: '   ' }, ctx())
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })

  it('is read-tier and scoped to back-office only', () => {
    expect(findJob.risk).toBe('read')
    expect(findJob.modes).toEqual(['back-office'])
    expect(findJob.name).toBe('find_job')
  })
})
