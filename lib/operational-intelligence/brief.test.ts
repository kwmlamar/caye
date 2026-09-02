import { describe, expect, it } from 'vitest'
import { buildOperationalBrief, renderOperationalBrief, type CayeOperationalStateReader, type OperationalSource } from './brief'
import type {
  BedrockEstimate,
  BedrockHealth,
  BedrockProject,
  BedrockProjectLabor,
  BedrockPurchaseOrder,
  BedrockReceipt,
  BedrockVendor,
} from '@/lib/domain-adapters/bedrock/types'

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const COMPANY = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-09-02T13:00:00.000Z')

const meta = (sourceEntityType: any, sourceEntityId: string, workspaceId = WORKSPACE) => ({
  sourceSystem: 'bedrock' as const,
  authority: 'external_authoritative' as const,
  sourceEntityType,
  sourceEntityId,
  workspaceId,
  companyId: COMPANY,
})

function source(overrides: Partial<OperationalSource> = {}): OperationalSource {
  const health: BedrockHealth = { ...meta('health', COMPANY), id: COMPANY, ok: true, companyName: 'ODS Construction' }
  return {
    health: async () => health,
    listProjects: async () => [],
    getProjectLabor: async (_workspaceId, projectId) => ({ ...meta('project_labor', projectId), id: projectId, projectId, regularHours: 0, overtimeHours: 0, totalHours: 0, entryCount: 0, workers: [] }),
    listProjectPurchaseOrders: async () => [],
    getVendor: async (_workspaceId, vendorId) => ({ ...meta('vendor', vendorId), id: vendorId, name: 'Vendor', status: 'active', email: null, phone: null }),
    listProjectReceipts: async () => [],
    listProjectEstimates: async () => [],
    ...overrides,
  }
}

function caye(overrides: Partial<Awaited<ReturnType<CayeOperationalStateReader['read']>>> = {}): CayeOperationalStateReader {
  return {
    read: async () => ({
      connection: { sourceSystem: 'bedrock', externalTenantId: COMPANY, status: 'active', updatedAt: NOW.toISOString() },
      attentionEvents: [],
      unresolvedMappings: [],
      syncStates: [],
      ...overrides,
    }),
  }
}

function project(id = 'p1'): BedrockProject {
  return {
    ...meta('project', id), id, name: 'Harbour House', description: null, status: 'active', location: 'Eleuthera',
    clientId: null, clientNameSnapshot: null, startDate: null, estimatedEndDate: null, budget: null, contractValue: null,
  }
}

function labor(id = 'p1', entries = 4): BedrockProjectLabor {
  return { ...meta('project_labor', id), id, projectId: id, regularHours: 30, overtimeHours: 2, totalHours: 32, entryCount: entries, workers: [] }
}

function po(id = 'po1'): BedrockPurchaseOrder {
  return { ...meta('purchase_order', id), id, projectId: 'p1', vendorId: 'v1', number: 'PO-14', status: 'ordered', orderDate: null, subtotal: 100, totalAmount: 100, items: [] }
}

function vendor(id = 'v1'): BedrockVendor {
  return { ...meta('vendor', id), id, name: 'Island Supply', status: 'active', email: null, phone: null }
}

function receipt(id = 'r1'): BedrockReceipt {
  return { ...meta('receipt', id), id, projectId: 'p1', vendorNameSnapshot: 'Island Supply', receiptDate: null, totalAmount: 100, status: 'processed', items: [] }
}

function estimate(id = 'e1'): BedrockEstimate {
  return { ...meta('estimate', id), id, projectId: 'p1', number: 'EST-9', name: null, title: null, clientNameSnapshot: null, status: 'draft', issueDate: null, subtotal: 1000, totalAmount: 1000, sections: [] }
}

describe('deterministic operational brief', () => {
  it('does not turn an empty authoritative result into a broad nothing-outstanding claim', async () => {
    const brief = await buildOperationalBrief({ workspaceId: WORKSPACE, source: source(), caye: caye(), now: NOW })
    const jobs = brief.sections.find(s => s.key === 'active_jobs')!
    expect(jobs.claims[0].kind).toBe('fact')
    expect(jobs.claims[0].text).toContain('zero rows')
    expect(jobs.claims[0].text).toContain('only establishes')
    expect(renderOperationalBrief(brief)).not.toMatch(/nothing outstanding/i)
    expect(brief.sections.find(s => s.key === 'unknown')!.claims.length).toBeGreaterThan(0)
  })

  it('states authoritative status as fact and keeps unresolved interpretation separate', async () => {
    const brief = await buildOperationalBrief({
      workspaceId: WORKSPACE,
      now: NOW,
      caye: caye(),
      source: source({
        listProjects: async () => [project()],
        getProjectLabor: async () => labor(),
        listProjectPurchaseOrders: async () => [po()],
        getVendor: async () => vendor(),
        listProjectReceipts: async () => [receipt()],
        listProjectEstimates: async () => [estimate()],
      }),
    })
    const procurement = brief.sections.find(s => s.key === 'materials_procurement')!.claims
    expect(procurement.some(c => c.kind === 'fact' && c.text.includes('is ordered'))).toBe(true)
    expect(procurement.some(c => c.kind === 'inference' && c.text.includes('appears unresolved'))).toBe(true)
    expect(procurement.find(c => c.kind === 'fact')!.provenance[0].authority).toBe('external_authoritative')
  })

  it('labels stale synchronization inference instead of presenting stale event state as current fact', async () => {
    const brief = await buildOperationalBrief({
      workspaceId: WORKSPACE,
      source: source(),
      caye: caye({ syncStates: [{ sourceSystem: 'bedrock', sourceCompanyId: COMPANY, stream: 'purchase_orders', updatedAt: '2026-09-02T01:00:00.000Z', watermark: null }] }),
      now: NOW,
    })
    const stale = brief.sections.find(s => s.key === 'attention')!.claims.find(c => c.stale)
    expect(stale?.kind).toBe('inference')
    expect(stale?.text).toContain('more than 6 hours')
  })

  it('preserves source provenance through rendering', async () => {
    const brief = await buildOperationalBrief({
      workspaceId: WORKSPACE,
      caye: caye(),
      now: NOW,
      source: source({ listProjects: async () => [project()], getProjectLabor: async () => labor() }),
    })
    const rendered = renderOperationalBrief(brief)
    expect(rendered).toContain('[FACT]')
    expect(rendered).toContain('bedrock:project:p1@2026-09-02T13:00:00.000Z')
  })

  it('identifies unsupported domains explicitly', async () => {
    const brief = await buildOperationalBrief({ workspaceId: WORKSPACE, source: source(), caye: caye(), now: NOW })
    const unknownText = brief.sections.find(s => s.key === 'unknown')!.claims.map(c => c.text).join(' ')
    expect(unknownText).toContain('accounts-receivable')
    expect(unknownText).toContain('pay-period ID')
    expect(unknownText).toContain('Bank settlement')
    expect(unknownText).toContain('Freight')
  })

  it('rejects cross-workspace authoritative rows', async () => {
    const foreign = { ...project(), workspaceId: '33333333-3333-4333-8333-333333333333' }
    await expect(buildOperationalBrief({
      workspaceId: WORKSPACE,
      source: source({ listProjects: async () => [foreign] }),
      caye: caye(),
      now: NOW,
    })).rejects.toThrow(/Cross-workspace/)
  })

  it('surfaces unresolved canonical mappings as Caye facts', async () => {
    const brief = await buildOperationalBrief({
      workspaceId: WORKSPACE,
      source: source(),
      caye: caye({ unresolvedMappings: [{ sourceSystem: 'bedrock', sourceCompanyId: COMPANY, sourceEntityType: 'purchase_order', sourceEntityId: 'po-x', lastObservedAt: NOW.toISOString() }] }),
      now: NOW,
    })
    const claim = brief.sections.find(s => s.key === 'attention')!.claims.find(c => c.text.includes('mapping is unresolved'))
    expect(claim?.kind).toBe('fact')
    expect(claim?.provenance[0].sourceSystem).toBe('caye')
  })
})
