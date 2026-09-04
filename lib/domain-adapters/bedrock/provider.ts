import 'server-only'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { BedrockConnection } from './types'

export type BedrockRow = Record<string, any>

export interface BedrockReadProvider {
  health(companyId: string): Promise<BedrockRow | null>
  listProjects(companyId: string, options?: { search?: string; status?: string; limit?: number }): Promise<BedrockRow[]>
  getProject(companyId: string, id: string): Promise<BedrockRow | null>
  listClients(companyId: string, options?: { search?: string; limit?: number }): Promise<BedrockRow[]>
  getClient(companyId: string, id: string): Promise<BedrockRow | null>
  getWorker(companyId: string, id: string): Promise<BedrockRow | null>
  listWorkers(companyId: string, options?: { status?: string; limit?: number }): Promise<BedrockRow[]>
  listProjectTimeEntries(companyId: string, projectId: string): Promise<BedrockRow[]>
  getPayPeriod(companyId: string, payPeriodId: string): Promise<BedrockRow | null>
  listPayrollEntries(companyId: string, payPeriodId: string): Promise<BedrockRow[]>
  /**
   * Company-scoped pay periods, filtered on `end_date` and capped like every
   * other list primitive here (mirrors listProjects/listClients exactly).
   * This exists so a caller can resolve "latest" or a date into a real
   * pay_period_id -- never so a human has to supply one. See
   * get-payroll-status.ts and get-payroll-owed.ts for the resolution logic
   * that depends on this.
   */
  listPayPeriods(companyId: string, options?: { from?: string; to?: string; status?: string; limit?: number }): Promise<BedrockRow[]>
  getEstimate(companyId: string, id: string): Promise<BedrockRow | null>
  listProjectEstimates(companyId: string, projectId: string): Promise<BedrockRow[]>
  getEstimateSections(estimateId: string): Promise<BedrockRow[]>
  getEstimateLineItems(estimateId: string): Promise<BedrockRow[]>
  getPurchaseOrder(companyId: string, id: string): Promise<BedrockRow | null>
  listPurchaseOrdersChangedSince(
    companyId: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
    notBefore?: string | null,
  ): Promise<BedrockRow[]>
  listProjectsChangedSince(
    companyId: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
    notBefore?: string | null,
  ): Promise<BedrockRow[]>
  listEstimatesChangedSince(
    companyId: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
    notBefore?: string | null,
  ): Promise<BedrockRow[]>
  /**
   * Receipts have NO `updated_at` column in Bedrock — only `created_at`. A
   * keyset poll would therefore catch new rows and silently miss every status
   * transition, which is worse than not polling at all because it looks like
   * it works. Change detection for receipts is a bounded full scan compared
   * against the snapshot fingerprint instead, which is honest at ODS's volume
   * (single-digit rows) and must not be reused for a large table.
   */
  listAllReceipts(companyId: string, limit: number): Promise<BedrockRow[]>
  listProjectPurchaseOrders(companyId: string, projectId: string): Promise<BedrockRow[]>
  getPurchaseOrderItems(purchaseOrderId: string): Promise<BedrockRow[]>
  getVendor(companyId: string, id: string): Promise<BedrockRow | null>
  listProjectReceipts(companyId: string, projectId: string): Promise<BedrockRow[]>
  getReceiptLineItems(receiptId: string): Promise<BedrockRow[]>
  /**
   * Pay periods have NO `updated_at` column in Bedrock — only `created_at`.
   * A keyset poll would therefore catch newly opened pay periods and
   * silently miss every `open -> processing -> paid` status transition,
   * which is worse than not polling at all because it looks like it works.
   * Change detection for pay periods is a bounded full scan compared against
   * the snapshot fingerprint instead, which is honest at ODS's volume (35
   * pay periods) and must not be reused for a large table.
   */
  listAllPayPeriods(companyId: string, limit: number): Promise<BedrockRow[]>
  listInvoices(companyId: string, options?: { status?: string; projectId?: string; limit?: number }): Promise<BedrockRow[]>
  /**
   * `payments` has no `company_id` column of its own — it only joins to an
   * invoice. Without a check here this would be a cross-tenant read: any
   * caller who guessed or otherwise obtained another company's invoice id
   * would get that company's payment rows back. So this validates the
   * invoice belongs to `companyId` first (the company-scoped parent) and
   * only queries `payments` by `invoice_id` once that lookup succeeds,
   * mirroring the "child tables without company_id are queried only after
   * their company-scoped parent is validated" rule in the adapter README.
   */
  listInvoicePayments(companyId: string, invoiceId: string): Promise<BedrockRow[]>
  /**
   * `materials` has no `company_id` column -- it is a single global cost
   * catalog, not a per-tenant one (verified live). There is deliberately no
   * `companyId` parameter here, unlike every other list method on this
   * interface; that absence is the table's own schema, not a scoping bug.
   * Used only by log_receipt's materials-matching step -- see
   * `BedrockMaterialCandidate` in types.ts for why this stays out of the
   * public read API.
   */
  listMaterials(options?: { limit?: number }): Promise<BedrockRow[]>
}

function throwOnError<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(`Bedrock query failed: ${result.error.message}`)
  return result.data
}

export class SupabaseBedrockReadProvider implements BedrockReadProvider {
  private readonly client: SupabaseClient

  constructor(connection: BedrockConnection) {
    this.client = createClient(connection.supabaseUrl, connection.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  async health(companyId: string) {
    return throwOnError(await this.client.from('companies').select('id,name').eq('id', companyId).maybeSingle())
  }

  async listProjects(companyId: string, options: { search?: string; status?: string; limit?: number } = {}) {
    let query = this.client.from('projects').select('*').eq('company_id', companyId)
    if (options.status) query = query.eq('status', options.status)
    if (options.search) query = query.ilike('name', `%${options.search}%`)
    return throwOnError(await query.order('created_at', { ascending: false }).limit(Math.min(options.limit ?? 100, 200))) ?? []
  }

  async getProject(companyId: string, id: string) {
    return throwOnError(await this.client.from('projects').select('*').eq('company_id', companyId).eq('id', id).maybeSingle())
  }

  async listClients(companyId: string, options: { search?: string; limit?: number } = {}) {
    let query = this.client.from('clients').select('*').eq('company_id', companyId)
    if (options.search) query = query.ilike('name', `%${options.search}%`)
    return throwOnError(await query.order('name').limit(Math.min(options.limit ?? 100, 200))) ?? []
  }

  async getClient(companyId: string, id: string) {
    return throwOnError(await this.client.from('clients').select('*').eq('company_id', companyId).eq('id', id).maybeSingle())
  }

  async getWorker(companyId: string, id: string) {
    return throwOnError(await this.client.from('workers').select('*').eq('company_id', companyId).eq('id', id).maybeSingle())
  }

  async listWorkers(companyId: string, options: { status?: string; limit?: number } = {}) {
    let query = this.client.from('workers').select('*').eq('company_id', companyId)
    if (options.status) query = query.eq('status', options.status)
    return throwOnError(await query.order('last_name').order('first_name').limit(Math.min(options.limit ?? 100, 200))) ?? []
  }

  async listProjectTimeEntries(companyId: string, projectId: string) {
    return throwOnError(await this.client.from('time_entries').select('id,worker_id,project_id,date,regular_hours,overtime_hours,workers(id,first_name,last_name)').eq('company_id', companyId).eq('project_id', projectId)) ?? []
  }

  async getPayPeriod(companyId: string, payPeriodId: string) {
    return throwOnError(await this.client.from('pay_periods').select('*').eq('company_id', companyId).eq('id', payPeriodId).maybeSingle())
  }

  /**
   * `voided_at` is selected so callers can exclude reversed entries (a
   * voided entry must never count toward what is owed) without a second
   * round trip. It is otherwise dropped before anything reaches a human --
   * see getPayrollOwed in adapter.ts. The `workers(...)` join is the same
   * shape listProjectTimeEntries uses, and is the only way to get a human
   * name onto a per-worker owed breakdown without a second query per worker.
   */
  async listPayrollEntries(companyId: string, payPeriodId: string) {
    return throwOnError(await this.client.from('payroll_entries').select('id,pay_period_id,worker_id,gross_pay,net_pay,total_paid,payment_status,is_paid,voided_at,workers(id,first_name,last_name)').eq('company_id', companyId).eq('pay_period_id', payPeriodId)) ?? []
  }

  /**
   * Mirrors listProjects/listClients: company-scoped, capped limit, `?? []`.
   * Filters on `end_date` rather than `start_date` because a pay period is
   * conventionally referred to by when it closes, and that is also the
   * column pay-period-change-source.ts already treats as authoritative for
   * ordering.
   */
  async listPayPeriods(companyId: string, options: { from?: string; to?: string; status?: string; limit?: number } = {}) {
    let query = this.client.from('pay_periods').select('*').eq('company_id', companyId)
    if (options.status) query = query.eq('status', options.status)
    if (options.from) query = query.gte('end_date', options.from)
    if (options.to) query = query.lte('end_date', options.to)
    return throwOnError(await query.order('end_date', { ascending: false }).limit(Math.min(options.limit ?? 100, 200))) ?? []
  }

  async getEstimate(companyId: string, id: string) {
    return throwOnError(await this.client.from('estimates').select('*').eq('company_id', companyId).eq('id', id).maybeSingle())
  }

  async listProjectEstimates(companyId: string, projectId: string) {
    return throwOnError(await this.client.from('estimates').select('*').eq('company_id', companyId).eq('project_id', projectId).order('created_at', { ascending: false })) ?? []
  }

  async getEstimateSections(estimateId: string) {
    return throwOnError(await this.client.from('estimate_sections').select('*').eq('estimate_id', estimateId).order('order_index')) ?? []
  }

  async getEstimateLineItems(estimateId: string) {
    return throwOnError(await this.client.from('estimate_line_items').select('*').eq('estimate_id', estimateId).order('order_index')) ?? []
  }

  /**
   * Company-scoped keyset scan over purchase orders, ordered by the pair that
   * makes the scan resumable.
   *
   * `updated_at` alone is not a safe cursor: several rows can share a value,
   * so `gt(updated_at)` can skip rows and `gte(updated_at)` can re-read them
   * forever. Ordering by `(updated_at, id)` and seeking past the exact pair is
   * total and stable.
   *
   * `notBefore` is an inclusive safety floor used by the change source to
   * re-read a small bounded overlap. That overlap is what protects against
   * source-side timestamp precision loss without turning every poll into an
   * unbounded historical scan.
   *
   * `updated_at` is trustworthy here specifically because Bedrock maintains it
   * with a `BEFORE UPDATE` trigger (`set_updated_at` -> `handle_updated_at`)
   * rather than relying on writers to remember. Do not copy this pattern onto
   * a table without checking that the trigger exists.
   */
  async listPurchaseOrdersChangedSince(
    companyId: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
    notBefore?: string | null,
  ) {
    let query = this.client.from('purchase_orders').select('*').eq('company_id', companyId)
    if (notBefore) query = query.gte('updated_at', notBefore)
    if (after) {
      query = query.or(
        `updated_at.gt.${after.updatedAt},and(updated_at.eq.${after.updatedAt},id.gt.${after.id})`,
      )
    }
    return throwOnError(
      await query
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(Math.min(Math.max(limit, 1), 500)),
    ) ?? []
  }

  /**
   * The same keyset scan for the two other tables that carry `updated_at`.
   * Kept as separate methods rather than one table-parameterised helper: the
   * table name is the tenant boundary's other half, and a caller-supplied
   * table string is exactly the shape that later grows into arbitrary read
   * access on a provider whose whole purpose is to have none.
   */
  async listProjectsChangedSince(
    companyId: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
    notBefore?: string | null,
  ) {
    let query = this.client.from('projects').select('*').eq('company_id', companyId)
    if (notBefore) query = query.gte('updated_at', notBefore)
    if (after) {
      query = query.or(
        `updated_at.gt.${after.updatedAt},and(updated_at.eq.${after.updatedAt},id.gt.${after.id})`,
      )
    }
    return throwOnError(
      await query
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(Math.min(Math.max(limit, 1), 500)),
    ) ?? []
  }

  async listEstimatesChangedSince(
    companyId: string,
    after: { updatedAt: string; id: string } | null,
    limit: number,
    notBefore?: string | null,
  ) {
    let query = this.client.from('estimates').select('*').eq('company_id', companyId)
    if (notBefore) query = query.gte('updated_at', notBefore)
    if (after) {
      query = query.or(
        `updated_at.gt.${after.updatedAt},and(updated_at.eq.${after.updatedAt},id.gt.${after.id})`,
      )
    }
    return throwOnError(
      await query
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(Math.min(Math.max(limit, 1), 500)),
    ) ?? []
  }

  /**
   * No `updated_at` on `receipts`, so there is no keyset position to resume
   * from and no way to ask the source what changed. The caller compares the
   * whole scan against its own fingerprints. Ordered for a stable scan, capped
   * like every other read here.
   */
  async listAllReceipts(companyId: string, limit: number) {
    return throwOnError(
      await this.client
        .from('receipts')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(Math.min(Math.max(limit, 1), 500)),
    ) ?? []
  }

  async getPurchaseOrder(companyId: string, id: string) {
    return throwOnError(await this.client.from('purchase_orders').select('*').eq('company_id', companyId).eq('id', id).maybeSingle())
  }

  async listProjectPurchaseOrders(companyId: string, projectId: string) {
    return throwOnError(await this.client.from('purchase_orders').select('*').eq('company_id', companyId).eq('project_id', projectId).order('created_at', { ascending: false })) ?? []
  }

  async getPurchaseOrderItems(purchaseOrderId: string) {
    return throwOnError(await this.client.from('purchase_order_items').select('*').eq('purchase_order_id', purchaseOrderId)) ?? []
  }

  async getVendor(companyId: string, id: string) {
    return throwOnError(await this.client.from('vendors').select('id,name,status,email,phone,company_id').eq('company_id', companyId).eq('id', id).maybeSingle())
  }

  async listProjectReceipts(companyId: string, projectId: string) {
    return throwOnError(await this.client.from('receipts').select('*').eq('company_id', companyId).eq('project_id', projectId).order('receipt_date', { ascending: false })) ?? []
  }

  async getReceiptLineItems(receiptId: string) {
    return throwOnError(await this.client.from('receipt_line_items').select('*').eq('receipt_id', receiptId)) ?? []
  }

  /**
   * No `updated_at` on `pay_periods`, so there is no keyset position to
   * resume from and no way to ask the source what changed. The caller
   * compares the whole scan against its own fingerprints. Ordered for a
   * stable scan, capped like every other read here.
   */
  async listAllPayPeriods(companyId: string, limit: number) {
    return throwOnError(
      await this.client
        .from('pay_periods')
        .select('*')
        .eq('company_id', companyId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(Math.min(Math.max(limit, 1), 500)),
    ) ?? []
  }

  async listInvoices(companyId: string, options: { status?: string; projectId?: string; limit?: number } = {}) {
    let query = this.client.from('invoices').select('*').eq('company_id', companyId)
    if (options.status) query = query.eq('status', options.status)
    if (options.projectId) query = query.eq('project_id', options.projectId)
    return throwOnError(await query.order('issue_date', { ascending: true }).limit(Math.min(options.limit ?? 100, 200))) ?? []
  }

  /**
   * See the interface doc comment: `payments` carries no `company_id`, so
   * the invoice is looked up company-scoped first and its existence is the
   * only thing that authorizes the subsequent `payments` query. A missing
   * or cross-tenant invoice id returns an empty array rather than querying
   * `payments` at all.
   */
  async listInvoicePayments(companyId: string, invoiceId: string) {
    const invoice = await this.client.from('invoices').select('id').eq('company_id', companyId).eq('id', invoiceId).maybeSingle()
    throwOnError(invoice)
    if (!invoice.data) return []
    return throwOnError(await this.client.from('payments').select('*').eq('invoice_id', invoiceId).order('payment_date', { ascending: true })) ?? []
  }

  /**
   * No `.eq('company_id', ...)` here -- see the interface doc comment, the
   * table has no such column. Capped like every other list method; 236 rows
   * live at time of writing, so a single page comfortably covers the whole
   * catalog for client-side token matching (same approach `resolveJob` uses
   * for projects).
   */
  async listMaterials(options: { limit?: number } = {}) {
    return throwOnError(
      await this.client
        .from('materials')
        .select('id,name,category,unit,unit_cost,supplier')
        .order('name')
        .limit(Math.min(options.limit ?? 500, 500)),
    ) ?? []
  }
}
