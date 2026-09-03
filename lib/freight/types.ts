export type FreightMatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNRESOLVED'

export interface EvidenceRef {
  source: 'email' | 'artifact' | 'bedrock'
  id: string
  workspaceId: string
  field?: string
}

/**
 * What a freight request is actually asking for is the commercial invoice tied to one identifier --
 * the forwarder just calls that identifier different things. King Ocean issues a dock receipt (D/R).
 * TWINex issues a warehouse number. Both mean the same request. A third forwarder is a third `kind`,
 * not a new parallel field and a new branch at every call site.
 */
export type FreightReferenceKind = 'dock_receipt' | 'warehouse_number' | 'shipment_ref'

export interface FreightReference {
  kind: FreightReferenceKind
  value: string
}

/** Single source of truth for how a reference kind reads in owner/forwarder-facing text. */
export const FREIGHT_REFERENCE_LABELS: Record<FreightReferenceKind, string> = {
  dock_receipt: 'Dock Receipt',
  warehouse_number: 'Warehouse',
  shipment_ref: 'Shipment Reference',
}

/** "Dock Receipt 10432233" / "Warehouse 188052" -- the label a document, reply, or filename should use. */
export function freightReferenceLabel(reference: FreightReference | null): string {
  if (!reference) return 'UNKNOWN'
  return `${FREIGHT_REFERENCE_LABELS[reference.kind]} ${reference.value}`
}

export interface FreightRequest {
  isFreightDocumentRequest: boolean
  evidence: string[]
  freightProvider: string | null
  senderName: string | null
  senderEmail: string | null
  /** Source of truth for "which identifier did the forwarder give us, and of what kind." */
  reference: FreightReference | null
  /**
   * Derived from `reference` (present only when reference.kind === 'dock_receipt'), not an independent
   * source of truth. Kept because it is read directly off FreightRequest by code outside this module's
   * scope for this change -- app/api/founder/freight-workflow/route.ts (dashboard labels, workspace_events
   * payloads) and components/dashboard/command-conversations/FreightWorkflowCard.tsx -- and because
   * existing unified_conversations.metadata.freight_workflow records were persisted with this shape.
   * Those callers are themselves King-Ocean-shaped (they will read `null` for a TWINex request) but are
   * out of scope here; do not write new logic against this field, read `reference` instead.
   */
  dockReceiptNumber: string | null
  /** Derived from `reference` (present only when reference.kind === 'shipment_ref'). See dockReceiptNumber. */
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
  /** Never absent -- buildFreightDocumentData throws before constructing this without one. */
  reference: FreightReference
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


/**
 * The entity id a freight-request relation must carry.
 *
 * A freight request is not its own record -- it IS the inbound email that asked
 * for the document. `business_artifact_relations.target_entity_id` is `uuid not
 * null`, and `target_entity_type = 'freight_request'` already carries the
 * distinction, so the id must be the bare message UUID.
 *
 * This exists because it was not. Both call sites wrote `freight:<uuid>`, which
 * is not valid UUID syntax, so every freight relation insert failed: production
 * held 0 freight relations against 2,354 total. The prefixed form is still the
 * workflow record's own id for the dashboard -- it just must never reach the
 * database as an entity id.
 */
export function freightRequestEntityId(idOrMessageId: string): string {
  return idOrMessageId.startsWith('freight:') ? idOrMessageId.slice('freight:'.length) : idOrMessageId
}
