import type { PurchaseEvidence, PurchaseLine } from './types'
import type { BedrockReceipt } from '@/lib/domain-adapters/bedrock/types'

const stringOrNull = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null
const numberOrNull = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null

/** Converts only explicitly extracted artifact fields; absent data remains null. */
export function purchaseEvidenceFromObservation(input: { workspaceId: string; artifactId: string; source?: 'email' | 'artifact'; filename?: string | null; content: Record<string, unknown> }): PurchaseEvidence {
  const c = input.content
  const rawLines = Array.isArray(c.line_items) ? c.line_items : Array.isArray(c.lines) ? c.lines : []
  const lines: PurchaseLine[] = rawLines.map((raw, index) => {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      description: stringOrNull(row.description ?? row.name), quantity: numberOrNull(row.quantity ?? row.qty),
      unitPrice: numberOrNull(row.unit_price ?? row.unitPrice), extendedPrice: numberOrNull(row.extended_price ?? row.total ?? row.amount),
      provenance: [{ source: input.source ?? 'artifact', id: input.artifactId, workspaceId: input.workspaceId, field: 'line_items[' + index + ']' }],
    }
  })
  const refs = [c.order_number, c.receipt_number, c.invoice_number, c.po_number, ...(Array.isArray(c.reference_numbers) ? c.reference_numbers : [])].map(stringOrNull).filter((v): v is string => !!v)
  return {
    id: input.artifactId, workspaceId: input.workspaceId, source: input.source ?? 'artifact',
    vendor: stringOrNull(c.vendor ?? c.seller ?? c.merchant), purchaseDate: stringOrNull(c.purchase_date ?? c.date), referenceNumbers: refs,
    orderNumber: stringOrNull(c.order_number), receiptNumber: stringOrNull(c.receipt_number ?? c.invoice_number), poNumber: stringOrNull(c.po_number),
    lines, subtotal: numberOrNull(c.subtotal), tax: numberOrNull(c.tax), shipping: numberOrNull(c.shipping ?? c.freight), total: numberOrNull(c.total),
    currency: stringOrNull(c.currency), purchaser: stringOrNull(c.purchaser ?? c.buyer), shippingAddress: stringOrNull(c.shipping_address ?? c.delivery_address),
    filename: input.filename ?? null, provenance: [{ source: input.source ?? 'artifact', id: input.artifactId, workspaceId: input.workspaceId }],
  }
}

/** Read-model conversion only: no Bedrock write capability is accepted or exposed. */
export function purchaseEvidenceFromBedrockReceipt(receipt: BedrockReceipt): PurchaseEvidence {
  return {
    id: receipt.id, workspaceId: receipt.workspaceId, source: 'bedrock', vendor: receipt.vendorNameSnapshot,
    purchaseDate: receipt.receiptDate, referenceNumbers: [], orderNumber: null, receiptNumber: receipt.id, poNumber: null,
    lines: receipt.items.map((item, index) => ({ description: item.name, quantity: item.quantity, unitPrice: null, extendedPrice: item.cost, provenance: [{ source: 'bedrock', id: receipt.id, workspaceId: receipt.workspaceId, field: 'items[' + index + ']' }] })),
    subtotal: null, tax: null, shipping: null, total: receipt.totalAmount, currency: null, purchaser: null, shippingAddress: null, filename: null,
    provenance: [{ source: 'bedrock', id: receipt.id, workspaceId: receipt.workspaceId }],
  }
}
