import 'server-only'

import type { BedrockReadProvider, BedrockRow } from './provider'
import { SupabaseBedrockReadProvider } from './provider'
import {
  BEDROCK_SOURCE_SYSTEM,
  EXTERNAL_AUTHORITATIVE,
  BedrockConnectionMissingError,
  BedrockNotFoundError,
  type BedrockAuthorityMetadata,
  type BedrockClient,
  type BedrockConnection,
  type BedrockConnectionResolver,
  type BedrockEstimate,
  type BedrockHealth,
  type BedrockInvoice,
  type BedrockListOptions,
  type BedrockMaterialCandidate,
  type BedrockPayPeriod,
  type BedrockPayrollOwed,
  type BedrockPayrollSummary,
  type BedrockProject,
  type BedrockProjectLabor,
  type BedrockPurchaseOrder,
  type BedrockReceipt,
  type BedrockVendor,
  type BedrockWorker,
} from './types'

type ProviderFactory = (connection: BedrockConnection) => BedrockReadProvider

const number = (value: unknown) => typeof value === 'number' ? value : Number(value ?? 0) || 0
const nullableNumber = (value: unknown) => value == null ? null : number(value)
const text = (value: unknown) => value == null ? null : String(value)
const round2 = (value: number) => Math.round(value * 100) / 100

export class BedrockAdapter {
  constructor(
    private readonly resolver: BedrockConnectionResolver,
    private readonly providerFactory: ProviderFactory = connection => new SupabaseBedrockReadProvider(connection),
  ) {}

  private async context(workspaceId: string) {
    const connection = await this.resolver.resolve(workspaceId)
    if (!connection) throw new BedrockConnectionMissingError(workspaceId)
    return { connection, provider: this.providerFactory(connection) }
  }

  private meta<T extends BedrockAuthorityMetadata['sourceEntityType']>(workspaceId: string, companyId: string, sourceEntityType: T, sourceEntityId: string): BedrockAuthorityMetadata & { sourceEntityType: T } {
    return { sourceSystem: BEDROCK_SOURCE_SYSTEM, authority: EXTERNAL_AUTHORITATIVE, sourceEntityType, sourceEntityId, workspaceId, companyId }
  }

  private project(row: BedrockRow, workspaceId: string, companyId: string): BedrockProject {
    return {
      ...this.meta(workspaceId, companyId, 'project', row.id), id: row.id,
      name: String(row.name ?? ''), description: text(row.description), status: text(row.status), location: text(row.location),
      clientId: text(row.client_id), clientNameSnapshot: text(row.client_name), startDate: text(row.start_date),
      estimatedEndDate: text(row.estimated_end_date), budget: nullableNumber(row.budget), contractValue: nullableNumber(row.contract_value),
    }
  }

  private client(row: BedrockRow, workspaceId: string, companyId: string): BedrockClient {
    return { ...this.meta(workspaceId, companyId, 'client', row.id), id: row.id, name: String(row.name ?? ''), email: text(row.email), phone: text(row.phone), address: text(row.address), city: text(row.city) }
  }

  private worker(row: BedrockRow, workspaceId: string, companyId: string): BedrockWorker {
    return { ...this.meta(workspaceId, companyId, 'worker', row.id), id: row.id, firstName: String(row.first_name ?? ''), lastName: String(row.last_name ?? ''), status: text(row.status), workerType: text(row.worker_type), hourlyRate: nullableNumber(row.hourly_rate) }
  }

  private payPeriod(row: BedrockRow, workspaceId: string, companyId: string): BedrockPayPeriod {
    return { ...this.meta(workspaceId, companyId, 'pay_period', row.id), id: row.id, startDate: text(row.start_date), endDate: text(row.end_date), status: text(row.status) }
  }

  async health(workspaceId: string): Promise<BedrockHealth> {
    const { connection, provider } = await this.context(workspaceId)
    const company = await provider.health(connection.companyId)
    return { ...this.meta(workspaceId, connection.companyId, 'health', connection.companyId), id: connection.companyId, ok: Boolean(company), companyName: text(company?.name) }
  }

  async listProjects(workspaceId: string, options: BedrockListOptions = {}) {
    const { connection, provider } = await this.context(workspaceId)
    const rows = await provider.listProjects(connection.companyId, options)
    return rows.map(row => this.project(row, workspaceId, connection.companyId))
  }

  async findProjects(workspaceId: string, search: string, limit = 20) { return this.listProjects(workspaceId, { search, limit }) }

  async getProject(workspaceId: string, id: string) {
    const { connection, provider } = await this.context(workspaceId)
    const row = await provider.getProject(connection.companyId, id)
    if (!row) throw new BedrockNotFoundError('project', id)
    return this.project(row, workspaceId, connection.companyId)
  }

  async listClients(workspaceId: string, options: Pick<BedrockListOptions, 'search' | 'limit'> = {}) {
    const { connection, provider } = await this.context(workspaceId)
    return (await provider.listClients(connection.companyId, options)).map(row => this.client(row, workspaceId, connection.companyId))
  }

  async findClients(workspaceId: string, search: string, limit = 20) { return this.listClients(workspaceId, { search, limit }) }

  async getClient(workspaceId: string, id: string) {
    const { connection, provider } = await this.context(workspaceId)
    const row = await provider.getClient(connection.companyId, id)
    if (!row) throw new BedrockNotFoundError('client', id)
    return this.client(row, workspaceId, connection.companyId)
  }

  async getWorker(workspaceId: string, id: string) {
    const { connection, provider } = await this.context(workspaceId)
    const row = await provider.getWorker(connection.companyId, id)
    if (!row) throw new BedrockNotFoundError('worker', id)
    return this.worker(row, workspaceId, connection.companyId)
  }

  async listWorkers(workspaceId: string, options: Pick<BedrockListOptions, 'status' | 'limit'> = {}) {
    const { connection, provider } = await this.context(workspaceId)
    return (await provider.listWorkers(connection.companyId, options)).map(row => this.worker(row, workspaceId, connection.companyId))
  }

  /**
   * Who already has time on a job, by day — and nothing else.
   *
   * Deliberately not a timesheet reader. Individual time entries are not an
   * AI-visible domain object (see `normalize.ts`, which suppresses
   * `time_entry` events on purpose), and hours and rates are none of a
   * duplicate check's business. This returns only the keys needed to answer
   * "has this person already been logged on this job that day", which is what
   * stops a re-reported crew day from doubling somebody's pay.
   */
  async listProjectTimeEntryKeys(
    workspaceId: string,
    projectId: string,
    date?: string
  ): Promise<Array<{ workerId: string; projectId: string; date: string }>> {
    const { connection, provider } = await this.context(workspaceId)
    if (!await provider.getProject(connection.companyId, projectId)) throw new BedrockNotFoundError('project', projectId)
    const rows = await provider.listProjectTimeEntries(connection.companyId, projectId)
    return rows
      .map(row => ({ workerId: String(row.worker_id), projectId, date: String(row.date ?? '') }))
      .filter(key => key.workerId && (!date || key.date === date))
  }

  async getProjectLabor(workspaceId: string, projectId: string): Promise<BedrockProjectLabor> {
    const { connection, provider } = await this.context(workspaceId)
    if (!await provider.getProject(connection.companyId, projectId)) throw new BedrockNotFoundError('project', projectId)
    const rows = await provider.listProjectTimeEntries(connection.companyId, projectId)
    const workers = new Map<string, { workerId: string; workerName: string; regularHours: number; overtimeHours: number; totalHours: number }>()
    let regularHours = 0, overtimeHours = 0
    for (const row of rows) {
      const regular = number(row.regular_hours), overtime = number(row.overtime_hours)
      regularHours += regular; overtimeHours += overtime
      const worker = Array.isArray(row.workers) ? row.workers[0] : row.workers
      const id = String(row.worker_id)
      const current = workers.get(id) ?? { workerId: id, workerName: `${worker?.first_name ?? ''} ${worker?.last_name ?? ''}`.trim(), regularHours: 0, overtimeHours: 0, totalHours: 0 }
      current.regularHours += regular; current.overtimeHours += overtime; current.totalHours += regular + overtime; workers.set(id, current)
    }
    return { ...this.meta(workspaceId, connection.companyId, 'project_labor', projectId), id: projectId, projectId, regularHours, overtimeHours, totalHours: regularHours + overtimeHours, entryCount: rows.length, workers: [...workers.values()] }
  }

  async getProjectWorkers(workspaceId: string, projectId: string) { return (await this.getProjectLabor(workspaceId, projectId)).workers }

  async getPayrollSummary(workspaceId: string, payPeriodId: string): Promise<BedrockPayrollSummary> {
    const { connection, provider } = await this.context(workspaceId)
    const period = await provider.getPayPeriod(connection.companyId, payPeriodId)
    if (!period) throw new BedrockNotFoundError('pay period', payPeriodId)
    const rows = await provider.listPayrollEntries(connection.companyId, payPeriodId)
    return {
      ...this.meta(workspaceId, connection.companyId, 'payroll_summary', payPeriodId), id: payPeriodId, payPeriodId,
      startDate: text(period.start_date), endDate: text(period.end_date), status: text(period.status), entryCount: rows.length,
      grossPay: rows.reduce((s, r) => s + number(r.gross_pay), 0), netPay: rows.reduce((s, r) => s + number(r.net_pay), 0), totalPaid: rows.reduce((s, r) => s + number(r.total_paid), 0),
      unpaidCount: rows.filter(r => r.payment_status === 'unpaid').length, partialCount: rows.filter(r => r.payment_status === 'partial').length, paidCount: rows.filter(r => r.payment_status === 'paid').length,
    }
  }

  /**
   * Pay periods in a date window -- the only way to resolve "latest" or a
   * plain date into a real pay_period_id. Exists so get_payroll_status never
   * has to ask a human for a database identifier: see that tool's
   * `resolvePayPeriodId` for the "ask about intent, never about
   * identifiers" resolution this enables.
   */
  async listPayPeriods(workspaceId: string, options: { from?: string; to?: string; status?: string; limit?: number } = {}) {
    const { connection, provider } = await this.context(workspaceId)
    return (await provider.listPayPeriods(connection.companyId, options)).map(row => this.payPeriod(row, workspaceId, connection.companyId))
  }

  /**
   * What ODS actually owes workers across a date range of pay periods.
   *
   * "Owed" is `net_pay - total_paid` per entry, never a raw sum of net_pay.
   * Partial payroll payments are routine at ODS -- payment_status is one of
   * unpaid | partial | paid -- so treating "unpaid" as all-or-nothing
   * overstated a real owner's question by roughly 37% (see the CAY ticket:
   * $24,298.45 of net pay on 55 non-fully-paid entries, of which $8,985.00
   * had already been paid, for a true owed figure of $15,313.45). A fully
   * paid entry contributes zero here because net_pay - total_paid is zero
   * for it, so nothing extra is needed to exclude it from the total; it is
   * simply not counted toward entryCount or the per-worker breakdown either,
   * since a $0 line has no place in "who do we still owe".
   *
   * Voided entries (`voided_at` not null) are reversed and excluded
   * entirely -- they must never count toward what is owed.
   *
   * periodCount/rangeStart/rangeEnd describe only the periods that actually
   * contributed a nonzero owed amount, not every period the date window
   * touched -- a fully-paid period inside the window contributes $0 and does
   * not appear in the range either.
   */
  async getPayrollOwed(workspaceId: string, options: { from?: string; to?: string } = {}): Promise<BedrockPayrollOwed> {
    const { connection, provider } = await this.context(workspaceId)
    const periods = await provider.listPayPeriods(connection.companyId, { from: options.from, to: options.to })

    const workerTotals = new Map<string, { workerId: string; workerName: string; owed: number }>()
    let totalOwed = 0
    let entryCount = 0
    let periodCount = 0
    let rangeStart: string | null = null
    let rangeEnd: string | null = null

    for (const period of periods) {
      const entries = await provider.listPayrollEntries(connection.companyId, period.id)
      let periodContributed = false

      for (const row of entries) {
        if (row.voided_at) continue
        const owed = number(row.net_pay) - number(row.total_paid)
        if (owed <= 0) continue

        periodContributed = true
        entryCount += 1
        totalOwed += owed

        const workerRow = Array.isArray(row.workers) ? row.workers[0] : row.workers
        const workerId = String(row.worker_id)
        const workerName = workerRow ? `${workerRow.first_name ?? ''} ${workerRow.last_name ?? ''}`.trim() : workerId
        const current = workerTotals.get(workerId) ?? { workerId, workerName, owed: 0 }
        current.owed += owed
        workerTotals.set(workerId, current)
      }

      if (periodContributed) {
        periodCount += 1
        const end = text(period.end_date)
        if (end && (!rangeEnd || end > rangeEnd)) rangeEnd = end
        if (end && (!rangeStart || end < rangeStart)) rangeStart = end
      }
    }

    return {
      ...this.meta(workspaceId, connection.companyId, 'payroll_owed', connection.companyId), id: connection.companyId,
      totalOwed: round2(totalOwed), entryCount, periodCount, rangeStart, rangeEnd,
      workers: [...workerTotals.values()].map(w => ({ ...w, owed: round2(w.owed) })).sort((a, b) => b.owed - a.owed),
    }
  }

  private async estimateFromRow(provider: BedrockReadProvider, row: BedrockRow, workspaceId: string, companyId: string): Promise<BedrockEstimate> {
    const [sections, items] = await Promise.all([provider.getEstimateSections(row.id), provider.getEstimateLineItems(row.id)])
    return {
      ...this.meta(workspaceId, companyId, 'estimate', row.id), id: row.id, projectId: text(row.project_id), number: text(row.estimate_number), name: text(row.name), title: text(row.title), clientNameSnapshot: text(row.client_name), status: text(row.status), issueDate: text(row.issue_date), subtotal: number(row.subtotal), totalAmount: number(row.total_amount),
      sections: sections.map(section => ({ id: section.id, name: String(section.name ?? ''), lineItems: items.filter(item => item.section_id === section.id).map(item => ({ id: item.id, description: text(item.description), quantity: number(item.quantity), unit: text(item.unit), totalAmount: number(item.amount) })) })),
    }
  }

  async getEstimate(workspaceId: string, id: string) {
    const { connection, provider } = await this.context(workspaceId)
    const row = await provider.getEstimate(connection.companyId, id)
    if (!row) throw new BedrockNotFoundError('estimate', id)
    return this.estimateFromRow(provider, row, workspaceId, connection.companyId)
  }

  async listProjectEstimates(workspaceId: string, projectId: string) {
    const { connection, provider } = await this.context(workspaceId)
    if (!await provider.getProject(connection.companyId, projectId)) throw new BedrockNotFoundError('project', projectId)
    return Promise.all((await provider.listProjectEstimates(connection.companyId, projectId)).map(row => this.estimateFromRow(provider, row, workspaceId, connection.companyId)))
  }

  private async purchaseOrderFromRow(provider: BedrockReadProvider, row: BedrockRow, workspaceId: string, companyId: string): Promise<BedrockPurchaseOrder> {
    const items = await provider.getPurchaseOrderItems(row.id)
    return { ...this.meta(workspaceId, companyId, 'purchase_order', row.id), id: row.id, projectId: text(row.project_id), vendorId: String(row.vendor_id), number: text(row.po_number), status: text(row.status), orderDate: text(row.order_date), subtotal: number(row.subtotal), totalAmount: number(row.total_amount), items: items.map(item => ({ id: item.id, description: text(item.description), quantity: number(item.quantity), unitPrice: number(item.unit_price), totalAmount: number(item.total_price) })) }
  }

  async getPurchaseOrder(workspaceId: string, id: string) {
    const { connection, provider } = await this.context(workspaceId)
    const row = await provider.getPurchaseOrder(connection.companyId, id)
    if (!row) throw new BedrockNotFoundError('purchase order', id)
    return this.purchaseOrderFromRow(provider, row, workspaceId, connection.companyId)
  }

  async listProjectPurchaseOrders(workspaceId: string, projectId: string) {
    const { connection, provider } = await this.context(workspaceId)
    if (!await provider.getProject(connection.companyId, projectId)) throw new BedrockNotFoundError('project', projectId)
    return Promise.all((await provider.listProjectPurchaseOrders(connection.companyId, projectId)).map(row => this.purchaseOrderFromRow(provider, row, workspaceId, connection.companyId)))
  }

  async getVendor(workspaceId: string, id: string): Promise<BedrockVendor> {
    const { connection, provider } = await this.context(workspaceId)
    const row = await provider.getVendor(connection.companyId, id)
    if (!row) throw new BedrockNotFoundError('vendor', id)
    return { ...this.meta(workspaceId, connection.companyId, 'vendor', row.id), id: row.id, name: String(row.name ?? ''), status: text(row.status), email: text(row.email), phone: text(row.phone) }
  }

  private invoice(row: BedrockRow, workspaceId: string, companyId: string): BedrockInvoice {
    return {
      ...this.meta(workspaceId, companyId, 'invoice', row.id), id: row.id,
      invoiceNumber: text(row.invoice_number), clientName: text(row.client_name), projectId: text(row.project_id), status: text(row.status),
      issueDate: text(row.issue_date), dueDate: text(row.due_date), totalAmount: number(row.total_amount), amountPaid: number(row.amount_paid),
      balanceDue: number(row.balance_due), sentAt: text(row.sent_at), paidAt: text(row.paid_at),
    }
  }

  async listInvoices(workspaceId: string, options: { status?: string; projectId?: string; limit?: number } = {}) {
    const { connection, provider } = await this.context(workspaceId)
    return (await provider.listInvoices(connection.companyId, options)).map(row => this.invoice(row, workspaceId, connection.companyId))
  }

  /**
   * Returns the invoice alongside its actual `payments` rows -- not the
   * invoice's own amount_paid/balance_due fields -- because "has this been
   * confirmed" must come from a real human attestation (a payments row),
   * not a derived counter. See listInvoicePayments on the provider for the
   * tenant-scoping check this relies on.
   *
   * Re-lists invoices to find the row rather than adding a single-invoice
   * provider primitive; at ODS's volume (single-digit to low-dozens
   * invoices) that is a bounded, honest cost, matching the same tradeoff
   * documented on listAllReceipts/listAllPayPeriods above. Revisit if a
   * tenant's invoice volume grows past what a capped list scan should do.
   */
  async getInvoiceWithPayments(workspaceId: string, id: string): Promise<{ invoice: BedrockInvoice; payments: BedrockRow[] }> {
    const { connection, provider } = await this.context(workspaceId)
    const rows = await provider.listInvoices(connection.companyId, { limit: 200 })
    const row = rows.find(r => r.id === id)
    if (!row) throw new BedrockNotFoundError('invoice', id)
    const payments = await provider.listInvoicePayments(connection.companyId, id)
    return { invoice: this.invoice(row, workspaceId, connection.companyId), payments }
  }

  async listProjectReceipts(workspaceId: string, projectId: string): Promise<BedrockReceipt[]> {
    const { connection, provider } = await this.context(workspaceId)
    if (!await provider.getProject(connection.companyId, projectId)) throw new BedrockNotFoundError('project', projectId)
    return Promise.all((await provider.listProjectReceipts(connection.companyId, projectId)).map(async row => ({ ...this.meta(workspaceId, connection.companyId, 'receipt', row.id), id: row.id, projectId: text(row.project_id), vendorNameSnapshot: text(row.vendor), receiptDate: text(row.receipt_date), totalAmount: number(row.total_amount), status: text(row.status), items: (await provider.getReceiptLineItems(row.id)).map(item => ({ id: item.id, materialId: text(item.material_id), name: text(item.receipt_name), quantity: number(item.qty), unit: text(item.unit), cost: number(item.total_cost) })) })))
  }

  /**
   * Not `companyId`-scoped -- see `BedrockReadProvider.listMaterials`'s doc
   * comment, the table itself has no tenant column. `context()` is still
   * called so a workspace with no Bedrock connection at all fails the same
   * way every other method here does, rather than materials being reachable
   * without one.
   */
  async listMaterials(workspaceId: string, options: { limit?: number } = {}): Promise<BedrockMaterialCandidate[]> {
    const { provider } = await this.context(workspaceId)
    const rows = await provider.listMaterials(options)
    return rows.map(row => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      category: text(row.category),
      unit: text(row.unit),
      unitCost: number(row.unit_cost),
      supplier: text(row.supplier),
    }))
  }
}
