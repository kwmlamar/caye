export type FreightMatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNRESOLVED'

export interface EvidenceRef {
  source: 'email' | 'artifact' | 'bedrock'
  id: string
  workspaceId: string
  field?: string
}

export interface FreightRequest {
  isFreightDocumentRequest: boolean
  evidence: string[]
  freightProvider: string | null
  senderName: string | null
  senderEmail: string | null
  dockReceiptNumber: string | null
  shipmentReference: string | null
  requestedDocument: string | null
  consolidationMentioned: boolean
  destination: string | null
  commodities: string[]
  requestedAt: string | null
}

export interface PurchaseLine {
  description: string | null
  quantity: number | null
  unitPrice: number | null
  extendedPrice: number | null
  provenance: EvidenceRef[]
}

export interface PurchaseEvidence {
  id: string
  workspaceId: string
  source: 'email' | 'artifact' | 'bedrock'
  vendor: string | null
  purchaseDate: string | null
  referenceNumbers: string[]
  orderNumber: string | null
  receiptNumber: string | null
  poNumber: string | null
  lines: PurchaseLine[]
  subtotal: number | null
  tax: number | null
  shipping: number | null
  total: number | null
  currency: string | null
  purchaser: string | null
  shippingAddress: string | null
  filename: string | null
  provenance: EvidenceRef[]
}

export interface RankedPurchaseEvidence {
  evidence: PurchaseEvidence
  score: number
  confidence: FreightMatchConfidence
  reasons: string[]
}

export interface FreightDocumentData {
  documentTitle: 'FREIGHT DOCUMENT'
  businessName: string
  freightProvider: string | null
  dockReceiptNumber: string
  vendor: string | null
  purchaseDate: string | null
  purchaseReference: string | null
  lines: PurchaseLine[]
  subtotal: number | null
  tax: number | null
  shipping: number | null
  total: number | null
  currency: string | null
  purchaser: string | null
  shippingAddress: string | null
  unresolvedFields: string[]
  sourceEvidence: EvidenceRef[]
}

export type FreightWorkflowStatus =
  | 'MATCH_FOUND'
  | 'AMBIGUOUS'
  | 'NO_MATCH'
  | 'READY_FOR_APPROVAL'
  | 'SENT'

