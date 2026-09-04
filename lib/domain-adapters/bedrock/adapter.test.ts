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
    listWorkers: async () => [],
    listProjectTimeEntries: async () => [{ id: 'time-1', worker_id: 'worker-1', regular_hours: 8, overtime_hours: 2, workers: { first_name: 'Ada', last_name: 'Builder' } }],
    getPayPeriod: async (companyId, id) => companyId === 'company-1' && id === 'period-1' ? { id, start_date: '2026-08-24', end_date: '2026-08-30', status: 'paid' } : null,
    listPayrollEntries: async () => [{ id: 'pay-1', gross_pay: 250, net_pay: 220, total_paid: 220, payment_status: 'paid' }],
    getEstimate: async (companyId, id) => companyId === 'company-1' && id === 'estimate-1' ? { id, company_id: companyId, project_id: 'project-1', estimate_number: 'E-1', status: 'draft', subtotal: 100, total_amount: 120 } : null,
    listProjectEstimates: async () => [{ id: 'estimate-1', project_id: 'project-1', estimate_number: 'E-1', subtotal: 100, total_amount: 120 }],
    getEstimateSections: async () => [{ id: 'section-1', name: 'Foundation' }],
    getEstimateLineItems: async () => [{ id: 'line-1', section_id: 'section-1', description: 'Concrete', quantity: 2, unit: 'yd', amount: 100 }],
    listPurchaseOrdersChangedSince: async () => [],
    listProjectsChangedSince: async () => [],
    listEstimatesChangedSince: async () => [],
    listAllReceipts: async () => [],
    getPurchaseOrder: async (companyId, id) => companyId === 'company-1' && id === 'po-1' ? { id, company_id: companyId, project_id: 'project-1', vendor_id: 'vendor-1', po_number: 'PO-1', total_amount: 50 } : null,
    listProjectPurchaseOrders: async () => [{ id: 'po-1', project_id: 'project-1', vendor_id: 'vendor-1', po_number: 'PO-1', total_amount: 50 }],
    getPurchaseOrderItems: async () => [{ id: 'poi-1', description: 'Lumber', quantity: 2, unit_price: 20, total_price: 40 }],
    getVendor: async (companyId, id) => companyId === 'company-1' && id === 'vendor-1' ? { id, company_id: companyId, name: 'Vendor' } : null,
    listProjectReceipts: async () => [{ id: 'receipt-1', project_id: 'project-1', vendor: 'Vendor', total_amount: 40, status: 'processed' }],
    getReceiptLineItems: async () => [{ id: 'rli-1', material_id: 'MAT-1', receipt_name: 'Lumber', qty: 2, unit: 'ea', total_cost: 40 }],
    listAllPayPeriods: async () => [],
    listPayPeriods: async () => [],
    listInvoices: async (companyId) => companyId === 'company-1' ? [{ id: 'invoice-1', company_id: companyId, project_id: 'project-1', invoice_number: 'INV-1', client_name: 'Client', status: 'sent', issue_date: '2026-07-01', due_date: '2026-07-31', total_amount: 100, amount_paid: 0, balance_due: 100, sent_at: '2026-07-01T00:00:00Z', paid_at: null }] : [],
    listInvoicePayments: async (companyId, invoiceId) => companyId === 'company-1' && invoiceId === 'invoice-1' ? [] : [],
    listMaterials: async () => [],
    ...overrides,
  }
}

const makeAdapter = (provider = fakeProvider()) => new BedrockAdapter(resolver, () => provider)

// Real ODS roster shape, quirks included: a trailing-space/empty-surname worker
// (Makenson), two workers that collide on the same first name (Rebins /
// Rebins Brother), and a full set of sensitive fields that must never reach
// adapter output.
const odsRosterRows = [
  { id: 'worker-cyrike', company_id: 'company-1', first_name: 'Cyrike', last_name: 'Tiler', status: 'active', worker_type: 'employee', hourly_rate: 18.75, national_insurance_number: 'NIB-001-CYRIKE', nib_number: 'NIB-001-CYRIKE', email: 'cyrike@example.com', phone: '555-0101', address: '1 Main St', emergency_contact_name: 'Jane Tiler', emergency_contact_phone: '555-0102', salary_amount: 39000 },
  { id: 'worker-earnest', company_id: 'company-1', first_name: 'Earnest', last_name: 'Phillipe', status: 'active', worker_type: 'employee', hourly_rate: 16.25, national_insurance_number: 'NIB-002-EARNEST', nib_number: 'NIB-002-EARNEST', email: 'earnest@example.com', phone: '555-0201', address: '2 Main St', emergency_contact_name: 'John Phillipe', emergency_contact_phone: '555-0202', salary_amount: 33800 },
  { id: 'worker-makenson', company_id: 'company-1', first_name: 'Makenson ', last_name: '', status: 'active', worker_type: 'employee', hourly_rate: 17.0, national_insurance_number: 'NIB-003-MAKENSON', nib_number: 'NIB-003-MAKENSON', email: 'makenson@example.com', phone: '555-0301', address: '3 Main St', emergency_contact_name: 'Marie Makenson', emergency_contact_phone: '555-0302', salary_amount: 35360 },
  { id: 'worker-rebins-1', company_id: 'company-1', first_name: 'Rebins', last_name: '', status: 'active', worker_type: 'employee', hourly_rate: 15.5, national_insurance_number: 'NIB-004-REBINS', nib_number: 'NIB-004-REBINS', email: 'rebins@example.com', phone: '555-0401', address: '4 Main St', emergency_contact_name: 'Rose Rebins', emergency_contact_phone: '555-0402', salary_amount: 32240 },
  { id: 'worker-rebins-2', company_id: 'company-1', first_name: 'Rebins', last_name: 'Brother', status: 'active', worker_type: 'employee', hourly_rate: 15.5, national_insurance_number: 'NIB-005-REBINS-B', nib_number: 'NIB-005-REBINS-B', email: 'rebins.brother@example.com', phone: '555-0501', address: '5 Main St', emergency_contact_name: 'Rose Rebins', emergency_contact_phone: '555-0502', salary_amount: 32240 },
  { id: 'worker-alaine', company_id: 'company-1', first_name: 'Alaine', last_name: 'Prophete', status: 'inactive', worker_type: 'employee', hourly_rate: 14.0, national_insurance_number: 'NIB-006-ALAINE', nib_number: 'NIB-006-ALAINE', email: 'alaine@example.com', phone: '555-0601', address: '6 Main St', emergency_contact_name: 'Alex Prophete', emergency_contact_phone: '555-0602', salary_amount: 29120 },
]

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

  // The ODS incident this fixes: an owner asked "how much do we owe
  // everyone" over WhatsApp and Caye asked her for pay-period IDs to answer
  // it. The real production figure behind that question was $15,313.45
  // owed across 55 non-fully-paid entries spanning pay periods from
  // 2026-02-21 to 2026-08-21 -- net_pay across those entries summed to
  // $24,298.45, of which $8,985.00 had already been paid. This fixture
  // preserves those exact dollar totals (scaled down to 4 entries across 2
  // periods rather than the literal 55/13, which would add nothing but
  // noise) so the regression this pins is the real incident's numbers, not
  // an arbitrary example.
  describe('getPayrollOwed', () => {
    const odsFebPeriod = { id: 'period-feb', company_id: 'company-1', start_date: '2026-02-15', end_date: '2026-02-21', status: 'partial' }
    const odsAugPeriod = { id: 'period-aug', company_id: 'company-1', start_date: '2026-08-15', end_date: '2026-08-21', status: 'partial' }
    const odsEntriesByPeriod: Record<string, any[]> = {
      'period-feb': [
        { id: 'e1', worker_id: 'worker-cyrike', net_pay: 10000.0, total_paid: 4000.0, payment_status: 'partial', voided_at: null, workers: { first_name: 'Cyrike', last_name: 'Tiler' } },
        { id: 'e2', worker_id: 'worker-earnest', net_pay: 6000.0, total_paid: 3000.0, payment_status: 'partial', voided_at: null, workers: { first_name: 'Earnest', last_name: 'Phillipe' } },
      ],
      'period-aug': [
        { id: 'e3', worker_id: 'worker-cyrike', net_pay: 5298.45, total_paid: 1000.0, payment_status: 'partial', voided_at: null, workers: { first_name: 'Cyrike', last_name: 'Tiler' } },
        { id: 'e4', worker_id: 'worker-earnest', net_pay: 3000.0, total_paid: 985.0, payment_status: 'partial', voided_at: null, workers: { first_name: 'Earnest', last_name: 'Phillipe' } },
      ],
    }

    it('computes owed as net_pay - total_paid across periods, never the raw net_pay sum', async () => {
      const provider = fakeProvider({
        listPayPeriods: async () => [odsFebPeriod, odsAugPeriod],
        listPayrollEntries: async (_companyId, payPeriodId) => odsEntriesByPeriod[payPeriodId] ?? [],
      })

      const owed = await makeAdapter(provider).getPayrollOwed('ws-1', { from: '2026-02-01', to: '2026-08-31' })

      const naiveNetPaySum = 10000.0 + 6000.0 + 5298.45 + 3000.0
      expect(naiveNetPaySum).toBeCloseTo(24298.45, 2)

      expect(owed.totalOwed).toBe(15313.45)
      expect(owed.totalOwed).not.toBe(naiveNetPaySum)
      expect(owed.entryCount).toBe(4)
      expect(owed.periodCount).toBe(2)
      expect(owed.rangeStart).toBe('2026-02-21')
      expect(owed.rangeEnd).toBe('2026-08-21')
    })

    it('produces a correct per-worker breakdown', async () => {
      const provider = fakeProvider({
        listPayPeriods: async () => [odsFebPeriod, odsAugPeriod],
        listPayrollEntries: async (_companyId, payPeriodId) => odsEntriesByPeriod[payPeriodId] ?? [],
      })

      const owed = await makeAdapter(provider).getPayrollOwed('ws-1', {})
      const cyrike = owed.workers.find((w) => w.workerId === 'worker-cyrike')
      const earnest = owed.workers.find((w) => w.workerId === 'worker-earnest')

      expect(cyrike).toMatchObject({ workerName: 'Cyrike Tiler', owed: 10298.45 })
      expect(earnest).toMatchObject({ workerName: 'Earnest Phillipe', owed: 5015.0 })
      expect(owed.workers).toHaveLength(2)
    })

    it('excludes voided entries from what is owed', async () => {
      const provider = fakeProvider({
        listPayPeriods: async () => [{ id: 'period-1', company_id: 'company-1', start_date: '2026-08-01', end_date: '2026-08-07', status: 'open' }],
        listPayrollEntries: async () => [
          { id: 'e1', worker_id: 'worker-voided', net_pay: 500, total_paid: 0, payment_status: 'unpaid', voided_at: '2026-08-05T00:00:00Z', workers: { first_name: 'Voided', last_name: 'Worker' } },
          { id: 'e2', worker_id: 'worker-2', net_pay: 300, total_paid: 100, payment_status: 'partial', voided_at: null, workers: { first_name: 'Still', last_name: 'Owed' } },
        ],
      })

      const owed = await makeAdapter(provider).getPayrollOwed('ws-1', {})
      expect(owed.totalOwed).toBe(200)
      expect(owed.entryCount).toBe(1)
      expect(owed.workers).toHaveLength(1)
      expect(owed.workers[0].workerId).toBe('worker-2')
    })

    it('a fully-paid period contributes zero and is excluded from the covered range', async () => {
      const provider = fakeProvider({
        listPayPeriods: async () => [
          { id: 'period-paid', company_id: 'company-1', start_date: '2026-05-01', end_date: '2026-05-07', status: 'paid' },
          { id: 'period-unpaid', company_id: 'company-1', start_date: '2026-06-01', end_date: '2026-06-07', status: 'open' },
        ],
        listPayrollEntries: async (_companyId, payPeriodId) =>
          payPeriodId === 'period-paid'
            ? [{ id: 'e1', worker_id: 'worker-1', net_pay: 400, total_paid: 400, payment_status: 'paid', voided_at: null, workers: { first_name: 'Fully', last_name: 'Paid' } }]
            : [{ id: 'e2', worker_id: 'worker-2', net_pay: 400, total_paid: 100, payment_status: 'partial', voided_at: null, workers: { first_name: 'Still', last_name: 'Owed' } }],
      })

      const owed = await makeAdapter(provider).getPayrollOwed('ws-1', {})
      expect(owed.totalOwed).toBe(300)
      expect(owed.periodCount).toBe(1)
      expect(owed.rangeStart).toBe('2026-06-07')
      expect(owed.rangeEnd).toBe('2026-06-07')
    })

    it('never surfaces deduction details or NIB data in the aggregate, even when present on raw rows', async () => {
      const provider = fakeProvider({
        listPayPeriods: async () => [{ id: 'period-1', company_id: 'company-1', start_date: '2026-08-01', end_date: '2026-08-07', status: 'open' }],
        listPayrollEntries: async () => [
          {
            id: 'e1',
            worker_id: 'worker-1',
            net_pay: 500,
            total_paid: 100,
            payment_status: 'partial',
            voided_at: null,
            deduction_details: { tax: 50, insurance: 20 },
            national_insurance_number: 'NIB-999',
            workers: { first_name: 'A', last_name: 'B', national_insurance_number: 'NIB-999', nib_number: 'NIB-999' },
          },
        ],
      })

      const owed = await makeAdapter(provider).getPayrollOwed('ws-1', {})
      const json = JSON.stringify(owed)
      expect(json).not.toMatch(/nib/i)
      expect(json).not.toMatch(/deduction/i)
    })
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

  it('lists the roster normalized as BedrockWorker with authority metadata set', async () => {
    const adapter = makeAdapter(fakeProvider({ listWorkers: async () => odsRosterRows }))
    const workers = await adapter.listWorkers('ws-1')
    expect(workers).toHaveLength(odsRosterRows.length)
    for (const worker of workers) {
      expect(worker).toMatchObject({ sourceSystem: 'bedrock', authority: 'external_authoritative', sourceEntityType: 'worker', workspaceId: 'ws-1', companyId: 'company-1' })
    }
    const makenson = workers.find(w => w.sourceEntityId === 'worker-makenson')
    expect(makenson).toMatchObject({ firstName: 'Makenson ', lastName: '', status: 'active', hourlyRate: 17.0 })
    const [rebins1, rebins2] = [workers.find(w => w.sourceEntityId === 'worker-rebins-1'), workers.find(w => w.sourceEntityId === 'worker-rebins-2')]
    expect(rebins1).toMatchObject({ firstName: 'Rebins', lastName: '' })
    expect(rebins2).toMatchObject({ firstName: 'Rebins', lastName: 'Brother' })
    const alaine = workers.find(w => w.sourceEntityId === 'worker-alaine')
    expect(alaine).toMatchObject({ status: 'inactive' })
  })

  it('passes a status filter through to the provider', async () => {
    let seenOptions: { status?: string; limit?: number } | undefined
    const adapter = makeAdapter(fakeProvider({
      listWorkers: async (companyId, options) => { seenOptions = options; return odsRosterRows.filter(row => row.status === 'active') },
    }))
    const workers = await adapter.listWorkers('ws-1', { status: 'active' })
    expect(seenOptions).toMatchObject({ status: 'active' })
    expect(workers.every(w => w.status === 'active')).toBe(true)
  })

  it('fails closed listing workers for a workspace with no domain connection', async () => {
    await expect(makeAdapter().listWorkers('missing-workspace')).rejects.toBeInstanceOf(BedrockConnectionMissingError)
  })

  it('never surfaces sensitive worker identifiers or contact/salary data in the normalized roster', async () => {
    const adapter = makeAdapter(fakeProvider({ listWorkers: async () => odsRosterRows }))
    const workers = await adapter.listWorkers('ws-1')
    const serialized = JSON.stringify(workers)
    for (const forbidden of [
      'national_insurance_number', 'nib_number', 'email', 'phone', 'address',
      'emergency_contact_name', 'emergency_contact_phone', 'salary_amount',
      'NIB-001-CYRIKE', 'cyrike@example.com', '555-0101', '1 Main St', 'Jane Tiler', '39000',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
