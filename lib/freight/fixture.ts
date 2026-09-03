import type { FreightRequest, PurchaseEvidence } from './types'

export const KING_OCEAN_FIXTURE: { request: FreightRequest; evidence: PurchaseEvidence } = {
  request: {
    isFreightDocumentRequest: true,
    evidence: ['dock_receipt:DR-12345', 'requested_document:invoice', 'freight_language', 'request_language'],
    freightProvider: 'King Ocean', senderName: 'Nicole Example', senderEmail: 'nicole@example.test',
    reference: { kind: 'dock_receipt', value: 'DR-12345' },
    dockReceiptNumber: 'DR-12345', shipmentReference: null, requestedDocument: 'invoice',
    consolidationMentioned: false, destination: 'Eleuthera, Bahamas', commodities: ['building materials'], requestedAt: '2026-08-31T14:00:00Z',
  },
  evidence: {
    id: 'receipt-home-depot-001', workspaceId: 'workspace-ods-fixture', source: 'email', vendor: 'Home Depot',
    purchaseDate: '2026-08-30T12:00:00Z', referenceNumbers: ['DR-12345', 'HD-9001'], orderNumber: 'HD-9001', receiptNumber: null, poNumber: null,
    lines: [
      { description: 'Pressure-treated lumber', quantity: 20, unitPrice: 18.5, extendedPrice: 370, provenance: [{ source: 'email', id: 'msg-receipt-1', workspaceId: 'workspace-ods-fixture', field: 'line_items[0]' }] },
      { description: 'Roofing fasteners', quantity: 10, unitPrice: 12.75, extendedPrice: 127.5, provenance: [{ source: 'email', id: 'msg-receipt-1', workspaceId: 'workspace-ods-fixture', field: 'line_items[1]' }] },
    ],
    subtotal: 497.5, tax: 0, shipping: 25, total: 522.5, currency: 'USD', purchaser: 'ODS Construction', shippingAddress: 'Sanitized fixture address', filename: 'home-depot-receipt.pdf',
    provenance: [{ source: 'email', id: 'msg-receipt-1', workspaceId: 'workspace-ods-fixture' }],
  },
}

/**
 * TWINex is ODS's other forwarder. It issues a warehouse number rather than a dock receipt, but the
 * request means the same thing King Ocean's does: send the commercial invoice of value. Consignee code
 * at TWINex is WALSIN; the usual contact is Keisha.
 */
export const TWINEX_FIXTURE: { request: FreightRequest; evidence: PurchaseEvidence } = {
  request: {
    isFreightDocumentRequest: true,
    evidence: ['warehouse_number:188052', 'requested_document:invoice', 'freight_language', 'request_language'],
    freightProvider: 'TWINex', senderName: 'Keisha Example', senderEmail: 'keisha@twinex.example.test',
    reference: { kind: 'warehouse_number', value: '188052' },
    dockReceiptNumber: null, shipmentReference: null, requestedDocument: 'invoice',
    consolidationMentioned: false, destination: 'Nassau, Bahamas', commodities: ['building materials'], requestedAt: '2026-08-31T14:00:00Z',
  },
  evidence: {
    id: 'receipt-home-depot-002', workspaceId: 'workspace-ods-fixture', source: 'email', vendor: 'Home Depot',
    purchaseDate: '2026-08-30T12:00:00Z', referenceNumbers: ['188052', 'HD-9002'], orderNumber: 'HD-9002', receiptNumber: null, poNumber: null,
    lines: [
      { description: 'Pressure-treated lumber', quantity: 20, unitPrice: 18.5, extendedPrice: 370, provenance: [{ source: 'email', id: 'msg-receipt-2', workspaceId: 'workspace-ods-fixture', field: 'line_items[0]' }] },
      { description: 'Roofing fasteners', quantity: 10, unitPrice: 12.75, extendedPrice: 127.5, provenance: [{ source: 'email', id: 'msg-receipt-2', workspaceId: 'workspace-ods-fixture', field: 'line_items[1]' }] },
    ],
    subtotal: 497.5, tax: 0, shipping: 25, total: 522.5, currency: 'USD', purchaser: 'ODS Construction', shippingAddress: 'Sanitized fixture address', filename: 'home-depot-receipt.pdf',
    provenance: [{ source: 'email', id: 'msg-receipt-2', workspaceId: 'workspace-ods-fixture' }],
  },
}
