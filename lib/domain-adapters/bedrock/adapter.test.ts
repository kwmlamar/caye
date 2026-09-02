import { describe, expect, it } from 'vitest'
import { BedrockAdapter } from './adapter'
import { BedrockConnectionMissingError, BedrockNotFoundError, type BedrockConnectionResolver } from './types'
import type { BedrockReadProvider } from './provider'

const connection = { workspaceId: 'ws-1', companyId: 'company-1', supabaseUrl: 'https://bedrock.invalid', serviceRoleKey: 'super-secret-key' }
const resolver: BedrockConnectionResolver = { resolve: async workspaceId => workspaceId === 'ws-1' ? connection : null }

function fakeProvider(overrides: Partial<BedrockReadProvider> = {}): BedrockReadProvider {
  return {
    health: async companyId => companyId === 'company-1' ? { id: companyId, name: 'ODS' } : null,
    listProjects: async () => [],
    getProject: async (companyId, id) => companyId === 'company-1' && id === 'project-1' ? { id, company_id: companyId, name: 'House', client_id: 'client-1', status: 'active' } : null,
    listClients: async () => [],
    getClient: async (companyId, id) => companyId === 'company-1' && id === 'client-1' ? { id, company_id: companyId, name: 'Client' } : null,
    getWorker: async (companyId, id) => companyId === 'company-1' && id === 'worker-1' ? { id, company_id: companyId, first_name: 'Ada', last_name: 'Builder', hourly_rate: 25 } : null,
    listProjectTimeEntries: async () => [{ id: 'time-1', worker_id: 'worker-1', regular_hours: 8, overtime_hours: 2, workers: { first_name: 'Ada', last_name: 'Builder' } }],
    getPayPeriod: async (companyId, id) => companyId === 'company-1' && id === 'period-1' ? { id, start_date: '2026-08-24', end_date: '2026-08-30', status: 'paid' } : null,
    listPayrollEntries: async () => [{ id: 'pay-1', gross_pay: 250, net_pay: 220, total_paid: 220, payment_status: 'paid' }],
    getEstimate: async (companyId, id) => companyId === 'company-1' && id === 'estimate-1' ? { id, company_id: companyId, project_id: 'project-1', estimate_number: 'E-1', status: 'draft', subtotal: 100, total_amount: 120 } : null,
    listProjectEstimates: async () => [{ id: 'estimate-1', project_id: 'project-1', estimate_number: 'E-1', subtotal: 100, total_amount: 120 }],
    getEstimateSections: async () => [{ id: 'section-1', name: 'Foundation' }],
    getEstimateLineItems: async () => [{ id: 'line-1', section_id: 'section-1', description: 'Concrete', quantity: 2, unit: 'yd', amount: 100 }],
    listPurchaseOrdersChangedSince: async () => [],
    getPurchaseOrder: async (companyId, id) => companyId === 'company-1' && id === 'po-1' ? { id, company_id: companyId, project_id: 'project-1', vendor_id: 'vendor-1', po_number: 'PO-1', total_amount: 50 } : null,
    listProjectPurchaseOrders: async () => [{ id: 'po-1', project_id: 'project-1', vendor_id: 'vendor-1', po_number: 'PO-1', total_amount: 50 }],
    getPurchaseOrderItems: async () => [{ id: 'poi-1', description: 'Lumber', quantity: 2, unit_price: 20, total_price: 40 }],
    getVendor: async (companyId, id) => companyId === 'company-1' && id === 'vendor-1' ? { id, company_id: companyId, name: 'Vendor' } : null,
    listProjectReceipts: async () => [{ id: 'receipt-1', project_id: 'project-1', vendor: 'Vendor', total_amount: 40, status: 'processed' }],
    getReceiptLineItems: async () => [{ id: 'rli-1', material_id: 'MAT-1', receipt_name: 'Lumber', qty: 2, unit: 'ea', total_cost: 40 }],
    ...overrides,
  }
}

const makeAdapter = (provider = fakeProvider()) => new BedrockAdapter(resolver, () => provider)

describe('BedrockAdapter', () => {
  it('fails closed when the workspace has no domain connection', async () => {
    await expect(makeAdapter().getProject('missing-workspace', 'project-1')).rejects.toBeInstanceOf(BedrockConnectionMissingError)
  })

  it('passes mapped company identity to every top-level entity lookup', async () => {
    let seenCompany: string | undefined
    const adapter = makeAdapter(fakeProvider({ getProject: async companyId => { seenCompany = companyId; return null } }))
    await expect(adapter.getProject('ws-1', 'foreign-project')).rejects.toBeInstanceOf(BedrockNotFoundError)
    expect(seenCompany).toBe('company-1')
  })

  it('normalizes authority metadata and project/client linkage', async () => {
    const project = await makeAdapter().getProject('ws-1', 'project-1')
    expect(project).toMatchObject({ sourceSystem: 'bedrock', authority: 'external_authoritative', sourceEntityType: 'project', sourceEntityId: 'project-1', workspaceId: 'ws-1', companyId: 'company-1', clientId: 'client-1' })
  })

  it('returns not-found for wrong-company IDs rather than leaking them', async () => {
    await expect(makeAdapter().getWorker('ws-1', 'worker-other-company')).rejects.toBeInstanceOf(BedrockNotFoundError)
  })

  it('derives project labor from company-scoped time entries', async () => {
    const labor = await makeAdapter().getProjectLabor('ws-1', 'project-1')
    expect(labor).toMatchObject({ regularHours: 8, overtimeHours: 2, totalHours: 10, entryCount: 1 })
    expect(labor.workers[0]).toMatchObject({ workerId: 'worker-1', totalHours: 10 })
  })

  it('summarizes payroll without returning deduction details', async () => {
    const summary = await makeAdapter().getPayrollSummary('ws-1', 'period-1')
    expect(summary).toMatchObject({ grossPay: 250, netPay: 220, totalPaid: 220, paidCount: 1 })
    expect(summary).not.toHaveProperty('deduction_details')
  })

  it('validates the project before traversing estimate children', async () => {
    let childQueried = false
    const adapter = makeAdapter(fakeProvider({ getProject: async () => null, getEstimateSections: async () => { childQueried = true; return [] } }))
    await expect(adapter.listProjectEstimates('ws-1', 'foreign-project')).rejects.toBeInstanceOf(BedrockNotFoundError)
    expect(childQueried).toBe(false)
  })

  it('preserves estimate sections and line-item meaning', async () => {
    const estimate = await makeAdapter().getEstimate('ws-1', 'estimate-1')
    expect(estimate.sections[0]).toMatchObject({ id: 'section-1', name: 'Foundation' })
    expect(estimate.sections[0].lineItems[0]).toMatchObject({ description: 'Concrete', quantity: 2, totalAmount: 100 })
  })

  it('validates the project before traversing purchase-order children', async () => {
    let itemsQueried = false
    const adapter = makeAdapter(fakeProvider({ getProject: async () => null, getPurchaseOrderItems: async () => { itemsQueried = true; return [] } }))
    await expect(adapter.listProjectPurchaseOrders('ws-1', 'foreign-project')).rejects.toBeInstanceOf(BedrockNotFoundError)
    expect(itemsQueried).toBe(false)
  })

  it('exposes only read operations and does not serialize credentials', () => {
    const adapter = makeAdapter()
    expect('createProject' in adapter).toBe(false)
    expect('updateEstimate' in adapter).toBe(false)
    expect('recordPayment' in adapter).toBe(false)
    expect(JSON.stringify(adapter)).not.toContain('super-secret-key')
  })
})
