export const BEDROCK_SOURCE_SYSTEM = 'bedrock' as const
export const EXTERNAL_AUTHORITATIVE = 'external_authoritative' as const

export type BedrockEntityType =
  | 'project'
  | 'client'
  | 'worker'
  | 'estimate'
  | 'purchase_order'
  | 'vendor'
  | 'receipt'
  | 'payroll_summary'
  | 'project_labor'
  | 'health'
  | 'invoice'

export interface BedrockAuthorityMetadata {
  sourceSystem: typeof BEDROCK_SOURCE_SYSTEM
  authority: typeof EXTERNAL_AUTHORITATIVE
  sourceEntityType: BedrockEntityType
  sourceEntityId: string
  workspaceId: string
  companyId: string
}

export interface BedrockDomainEntity extends BedrockAuthorityMetadata {
  id: string
}

export interface BedrockConnection {
  workspaceId: string
  companyId: string
  supabaseUrl: string
  serviceRoleKey: string
}

export interface BedrockProject extends BedrockDomainEntity {
  sourceEntityType: 'project'
  name: string
  description: string | null
  status: string | null
  location: string | null
  clientId: string | null
  clientNameSnapshot: string | null
  startDate: string | null
  estimatedEndDate: string | null
  budget: number | null
  contractValue: number | null
}

export interface BedrockClient extends BedrockDomainEntity {
  sourceEntityType: 'client'
  name: string
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
}

export interface BedrockWorker extends BedrockDomainEntity {
  sourceEntityType: 'worker'
  firstName: string
  lastName: string
  status: string | null
  workerType: string | null
  hourlyRate: number | null
}

export interface BedrockProjectLabor extends BedrockDomainEntity {
  sourceEntityType: 'project_labor'
  projectId: string
  regularHours: number
  overtimeHours: number
  totalHours: number
  entryCount: number
  workers: Array<{
    workerId: string
    workerName: string
    regularHours: number
    overtimeHours: number
    totalHours: number
  }>
}

export interface BedrockPayrollSummary extends BedrockDomainEntity {
  sourceEntityType: 'payroll_summary'
  payPeriodId: string
  startDate: string | null
  endDate: string | null
  status: string | null
  entryCount: number
  grossPay: number
  netPay: number
  totalPaid: number
  unpaidCount: number
  partialCount: number
  paidCount: number
}

export interface BedrockEstimate extends BedrockDomainEntity {
  sourceEntityType: 'estimate'
  projectId: string | null
  number: string | null
  name: string | null
  title: string | null
  clientNameSnapshot: string | null
  status: string | null
  issueDate: string | null
  subtotal: number
  totalAmount: number
  sections: Array<{
    id: string
    name: string
    lineItems: Array<{
      id: string
      description: string | null
      quantity: number
      unit: string | null
      totalAmount: number
    }>
  }>
}

export interface BedrockPurchaseOrder extends BedrockDomainEntity {
  sourceEntityType: 'purchase_order'
  projectId: string | null
  vendorId: string
  number: string | null
  status: string | null
  orderDate: string | null
  subtotal: number
  totalAmount: number
  items: Array<{
    id: string
    description: string | null
    quantity: number
    unitPrice: number
    totalAmount: number
  }>
}

export interface BedrockVendor extends BedrockDomainEntity {
  sourceEntityType: 'vendor'
  name: string
  status: string | null
  email: string | null
  phone: string | null
}

export interface BedrockReceipt extends BedrockDomainEntity {
  sourceEntityType: 'receipt'
  projectId: string | null
  vendorNameSnapshot: string | null
  receiptDate: string | null
  totalAmount: number
  status: string | null
  items: Array<{
    id: string
    materialId: string | null
    name: string | null
    quantity: number
    unit: string | null
    cost: number
  }>
}

/**
 * Deliberately does not carry client_email, client_phone, client_address,
 * notes, or terms — the same restraint BedrockClient/BedrockVendor show for
 * contact and free-text fields the read adapter has no reason to surface.
 */
export interface BedrockInvoice extends BedrockDomainEntity {
  sourceEntityType: 'invoice'
  invoiceNumber: string | null
  clientName: string | null
  projectId: string | null
  status: string | null
  issueDate: string | null
  dueDate: string | null
  totalAmount: number
  amountPaid: number
  balanceDue: number
  sentAt: string | null
  paidAt: string | null
}

export interface BedrockHealth extends BedrockDomainEntity {
  sourceEntityType: 'health'
  ok: boolean
  companyName: string | null
}

export interface BedrockListOptions {
  search?: string
  status?: string
  limit?: number
}

export interface BedrockConnectionResolver {
  resolve(workspaceId: string): Promise<BedrockConnection | null>
}

export class BedrockConnectionMissingError extends Error {
  constructor(workspaceId: string) {
    super(`No Bedrock domain connection is configured for workspace ${workspaceId}`)
    this.name = 'BedrockConnectionMissingError'
  }
}

export class BedrockNotFoundError extends Error {
  constructor(entityType: string, id: string) {
    super(`${entityType} not found`)
    this.name = 'BedrockNotFoundError'
  }
}
