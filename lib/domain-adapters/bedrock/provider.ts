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
  listProjectTimeEntries(companyId: string, projectId: string): Promise<BedrockRow[]>
  getPayPeriod(companyId: string, payPeriodId: string): Promise<BedrockRow | null>
  listPayrollEntries(companyId: string, payPeriodId: string): Promise<BedrockRow[]>
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

  async listProjectTimeEntries(companyId: string, projectId: string) {
    return throwOnError(await this.client.from('time_entries').select('id,worker_id,project_id,date,regular_hours,overtime_hours,workers(id,first_name,last_name)').eq('company_id', companyId).eq('project_id', projectId)) ?? []
  }

  async getPayPeriod(companyId: string, payPeriodId: string) {
    return throwOnError(await this.client.from('pay_periods').select('*').eq('company_id', companyId).eq('id', payPeriodId).maybeSingle())
  }

  async listPayrollEntries(companyId: string, payPeriodId: string) {
    return throwOnError(await this.client.from('payroll_entries').select('id,pay_period_id,worker_id,gross_pay,net_pay,total_paid,payment_status,is_paid').eq('company_id', companyId).eq('pay_period_id', payPeriodId)) ?? []
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
}
