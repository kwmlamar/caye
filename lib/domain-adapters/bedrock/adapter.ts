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
  type BedrockListOptions,
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

  private meta(workspaceId: string, companyId: string, sourceEntityType: BedrockAuthorityMetadata['sourceEntityType'], sourceEntityId: string): BedrockAuthorityMetadata {
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

  async listProjectReceipts(workspaceId: string, projectId: string): Promise<BedrockReceipt[]> {
    const { connection, provider } = await this.context(workspaceId)
    if (!await provider.getProject(connection.companyId, projectId)) throw new BedrockNotFoundError('project', projectId)
    return Promise.all((await provider.listProjectReceipts(connection.companyId, projectId)).map(async row => ({ ...this.meta(workspaceId, connection.companyId, 'receipt', row.id), id: row.id, projectId: text(row.project_id), vendorNameSnapshot: text(row.vendor), receiptDate: text(row.receipt_date), totalAmount: number(row.total_amount), status: text(row.status), items: (await provider.getReceiptLineItems(row.id)).map(item => ({ id: item.id, materialId: text(item.material_id), name: text(item.receipt_name), quantity: number(item.qty), unit: text(item.unit), cost: number(item.total_cost) })) })))
  }
}
