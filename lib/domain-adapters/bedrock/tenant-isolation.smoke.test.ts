import { describe, expect, it } from 'vitest'
import { BedrockAdapter } from './adapter'
import type { BedrockReadProvider } from './provider'
import { BedrockNotFoundError, type BedrockConnectionResolver } from './types'

const connection = {
  workspaceId: 'ws-1',
  companyId: 'company-1',
  supabaseUrl: 'https://bedrock.invalid',
  serviceRoleKey: 'secret',
}
const resolver: BedrockConnectionResolver = { resolve: async () => connection }

function providerWith(overrides: Partial<BedrockReadProvider>): BedrockReadProvider {
  return {
    health: async () => null,
    listProjects: async () => [],
    getProject: async () => null,
    listClients: async () => [],
    getClient: async () => null,
    getWorker: async () => null,
    listWorkers: async () => [],
    listProjectTimeEntries: async () => [],
    getPayPeriod: async () => null,
    listPayrollEntries: async () => [],
    getEstimate: async () => null,
    listProjectEstimates: async () => [],
    getEstimateSections: async () => [],
    getEstimateLineItems: async () => [],
    getPurchaseOrder: async () => null,
    listPurchaseOrdersChangedSince: async () => [],
    listProjectsChangedSince: async () => [],
    listEstimatesChangedSince: async () => [],
    listAllReceipts: async () => [],
    listProjectPurchaseOrders: async () => [],
    getPurchaseOrderItems: async () => [],
    getVendor: async () => null,
    listProjectReceipts: async () => [],
    getReceiptLineItems: async () => [],
    listAllPayPeriods: async () => [],
    listPayPeriods: async () => [],
    listInvoices: async () => [],
    listInvoicePayments: async () => [],
    ...overrides,
  }
}

describe('Bedrock parent-before-child tenant isolation', () => {
  it('does not query project labor children when the company-scoped project lookup fails', async () => {
    const calls: string[] = []
    const provider = providerWith({
      getProject: async companyId => { calls.push(`project:${companyId}`); return null },
      listProjectTimeEntries: async () => { calls.push('time_entries'); return [] },
    })
    const adapter = new BedrockAdapter(resolver, () => provider)

    await expect(adapter.getProjectLabor('ws-1', 'foreign-project')).rejects.toBeInstanceOf(BedrockNotFoundError)
    expect(calls).toEqual(['project:company-1'])
  })

  it('does not query receipt children when the company-scoped project lookup fails', async () => {
    const calls: string[] = []
    const provider = providerWith({
      getProject: async companyId => { calls.push(`project:${companyId}`); return null },
      listProjectReceipts: async () => { calls.push('receipts'); return [] },
      getReceiptLineItems: async () => { calls.push('receipt_items'); return [] },
    })
    const adapter = new BedrockAdapter(resolver, () => provider)

    await expect(adapter.listProjectReceipts('ws-1', 'foreign-project')).rejects.toBeInstanceOf(BedrockNotFoundError)
    expect(calls).toEqual(['project:company-1'])
  })

  it('does not query payments when the invoice is not among the company-scoped invoice list', async () => {
    const calls: string[] = []
    const provider = providerWith({
      listInvoices: async companyId => { calls.push(`invoices:${companyId}`); return [] },
      listInvoicePayments: async () => { calls.push('payments'); return [] },
    })
    const adapter = new BedrockAdapter(resolver, () => provider)

    await expect(adapter.getInvoiceWithPayments('ws-1', 'foreign-invoice')).rejects.toBeInstanceOf(BedrockNotFoundError)
    expect(calls).toEqual(['invoices:company-1'])
  })
})
