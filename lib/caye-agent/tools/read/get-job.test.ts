import { describe, it, expect } from 'vitest'
import {
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockClient,
  type BedrockEstimate,
  type BedrockProject,
  type BedrockProjectLabor,
  type BedrockPurchaseOrder,
  type BedrockReceipt,
} from '@/lib/domain-adapters/bedrock'
import type { ToolContext } from '../types'
import { makeGetJob, type JobDetailAdapter } from './get-job'

const WORKSPACE = 'ws-ods'

function meta<T extends string>(sourceEntityType: T, id: string) {
  return {
    sourceSystem: 'bedrock' as const,
    authority: 'external_authoritative' as const,
    sourceEntityType,
    sourceEntityId: id,
    workspaceId: WORKSPACE,
    companyId: 'ods-co',
  }
}

const BLUE_SKY: BedrockProject = {
  ...meta('project', 'proj-blue-sky'),
  id: 'proj-blue-sky',
  name: 'Blue Sky Villa — Great Room Flooring',
  description: null,
  status: 'active',
  location: 'Blue Sky Villa',
  clientId: 'client-eric-mann',
  clientNameSnapshot: 'Eric Mann',
  startDate: '2026-06-01',
  estimatedEndDate: '2026-10-01',
  budget: 42000,
  contractValue: 48500,
}

const ERIC_MANN: BedrockClient = {
  ...meta('client', 'client-eric-mann'),
  id: 'client-eric-mann',
  name: 'Eric Mann',
  email: 'eric@example.com',
  phone: '+1-242-555-0100',
  address: null,
  city: 'Nassau',
}

const LABOR: BedrockProjectLabor = {
  ...meta('project_labor', 'proj-blue-sky'),
  id: 'proj-blue-sky',
  projectId: 'proj-blue-sky',
  regularHours: 120,
  overtimeHours: 8,
  totalHours: 128,
  entryCount: 22,
  workers: [{ workerId: 'worker-1', workerName: 'Ada Builder', regularHours: 120, overtimeHours: 8, totalHours: 128 }],
}

const ESTIMATES: BedrockEstimate[] = [
  { ...meta('estimate', 'est-1'), id: 'est-1', projectId: 'proj-blue-sky', number: 'E-1', name: null, title: null, clientNameSnapshot: 'Eric Mann', status: 'approved', issueDate: '2026-06-01', subtotal: 40000, totalAmount: 44000, sections: [] },
]

const PURCHASE_ORDERS: BedrockPurchaseOrder[] = [
  { ...meta('purchase_order', 'po-1'), id: 'po-1', projectId: 'proj-blue-sky', vendorId: 'vendor-1', number: 'PO-1', status: 'received', orderDate: '2026-06-15', subtotal: 1800, totalAmount: 1980, items: [] },
]

const RECEIPTS: BedrockReceipt[] = [
  { ...meta('receipt', 'rcpt-1'), id: 'rcpt-1', projectId: 'proj-blue-sky', vendorNameSnapshot: 'Virginia Tile', receiptDate: '2026-07-01', totalAmount: 620, status: 'processed', items: [] },
]

function fakeAdapter(overrides: Partial<JobDetailAdapter> = {}): JobDetailAdapter {
  return {
    listProjects: async (workspaceId) => (workspaceId === WORKSPACE ? [BLUE_SKY] : []),
    getProject: async (workspaceId, id) => {
      if (workspaceId !== WORKSPACE || id !== BLUE_SKY.id) throw new BedrockNotFoundError('project', id)
      return BLUE_SKY
    },
    getProjectLabor: async () => LABOR,
    listProjectEstimates: async () => ESTIMATES,
    listProjectPurchaseOrders: async () => PURCHASE_ORDERS,
    listProjectReceipts: async () => RECEIPTS,
    getClient: async () => ERIC_MANN,
    ...overrides,
  }
}

function ctx(): ToolContext {
  return { workspaceId: WORKSPACE, callerRole: 'owner' } as unknown as ToolContext
}

describe('get_job tool', () => {
  it('returns full project detail — identity, client, labor, and summarized child collections — when given an id', async () => {
    const getJob = makeGetJob(() => fakeAdapter())
    const result = await getJob.execute({ id: 'proj-blue-sky' }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const data = result.data as any
    expect(data.match).toBe('one')
    expect(data.job).toMatchObject({
      id: 'proj-blue-sky',
      name: 'Blue Sky Villa — Great Room Flooring',
      status: 'active',
      location: 'Blue Sky Villa',
      contract_value: 48500,
      budget: 42000,
    })
    expect(data.job.client).toMatchObject({ available: true, id: 'client-eric-mann', name: 'Eric Mann' })
    expect(data.job.labor).toMatchObject({ available: true, total_hours: 128, regular_hours: 120, overtime_hours: 8, entry_count: 22 })
    expect(data.job.estimates).toMatchObject({ available: true, count: 1, total_amount: 44000 })
    expect(data.job.estimates.recent[0]).toMatchObject({ id: 'est-1', number: 'E-1' })
    expect(data.job.purchase_orders).toMatchObject({ available: true, count: 1, total_amount: 1980 })
    expect(data.job.receipts).toMatchObject({ available: true, count: 1, total_amount: 620 })
  })

  it('resolves by informal name (the same resolution find_job uses) when no id is given', async () => {
    const getJob = makeGetJob(() => fakeAdapter())
    const result = await getJob.execute({ name: 'the Mann job' }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.match).toBe('one')
    expect(data.job.id).toBe('proj-blue-sky')
  })

  it('returns the ambiguity signal and fetches nothing when a name resolves to several jobs', async () => {
    let projectFetched = false
    const parksA: BedrockProject = { ...BLUE_SKY, id: 'proj-parks-1', name: 'Parks Residence', clientNameSnapshot: 'Mr. Richard Parks', clientId: 'client-parks' }
    const parksB: BedrockProject = { ...BLUE_SKY, id: 'proj-parks-2', name: 'Parks Cottage', clientNameSnapshot: 'Mr. Richard Parks', clientId: 'client-parks' }

    const getJob = makeGetJob(() =>
      fakeAdapter({
        listProjects: async () => [parksA, parksB],
        getProject: async (_wsId, id) => {
          projectFetched = true
          return id === parksA.id ? parksA : parksB
        },
      }),
    )

    const result = await getJob.execute({ name: 'Parks' }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.match).toBe('many')
    expect(data.candidates).toHaveLength(2)
    expect(data.job).toBeUndefined()
    expect(projectFetched).toBe(false)
  })

  it('returns match "none" without error when a name matches nothing', async () => {
    const getJob = makeGetJob(() => fakeAdapter({ listProjects: async () => [] }))
    const result = await getJob.execute({ name: 'Nobody Has Heard Of This' }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as any).match).toBe('none')
  })

  it('rejects a call with neither id nor name', async () => {
    const getJob = makeGetJob(() => fakeAdapter())
    const result = await getJob.execute({}, ctx())
    expect(result.ok).toBe(false)
  })

  it('returns a clean ok:false error (never throws) when the workspace has no Bedrock connection', async () => {
    const getJob = makeGetJob(() => {
      throw new BedrockConnectionMissingError(WORKSPACE)
    })
    const result = await getJob.execute({ id: 'proj-blue-sky' }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/construction ledger/i)
  })

  it('returns a clean not-found error for an id that does not resolve in this workspace', async () => {
    const getJob = makeGetJob(() => fakeAdapter())
    const result = await getJob.execute({ id: 'proj-does-not-exist' }, ctx())
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('proj-does-not-exist')
  })

  it('degrades gracefully: a failing child collection is marked unavailable, the rest of the job still returns', async () => {
    const getJob = makeGetJob(() =>
      fakeAdapter({
        listProjectPurchaseOrders: async () => {
          throw new Error('TropiTrack purchase_orders query timed out')
        },
      }),
    )

    const result = await getJob.execute({ id: 'proj-blue-sky' }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.job.purchase_orders).toMatchObject({ available: false })
    expect(data.job.purchase_orders.error).toMatch(/timed out/)
    // Everything else still made it through.
    expect(data.job.labor.available).toBe(true)
    expect(data.job.estimates.available).toBe(true)
    expect(data.job.receipts.available).toBe(true)
    expect(data.job.client.available).toBe(true)
  })

  it('degrades the client section without failing the project when the project has no linked client', async () => {
    const noClientProject: BedrockProject = { ...BLUE_SKY, clientId: null }
    let getClientCalled = false
    const getJob = makeGetJob(() =>
      fakeAdapter({
        getProject: async () => noClientProject,
        getClient: async () => {
          getClientCalled = true
          return ERIC_MANN
        },
      }),
    )

    const result = await getJob.execute({ id: 'proj-blue-sky' }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.job.client).toMatchObject({ available: true, id: null, name: 'Eric Mann' })
    expect(getClientCalled).toBe(false)
  })

  it('is read-tier and scoped to back-office only', () => {
    const getJob = makeGetJob(() => fakeAdapter())
    expect(getJob.risk).toBe('read')
    expect(getJob.modes).toEqual(['back-office'])
    expect(getJob.name).toBe('get_job')
  })
})
