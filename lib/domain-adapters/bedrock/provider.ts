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
