import { FREIGHT_REFERENCE_LABELS, freightReferenceLabel } from './types'
import type { FreightDocumentData, FreightRequest, PurchaseEvidence } from './types'

const money = (n: number | null, currency: string | null) => n === null ? 'UNKNOWN' : `${currency ?? ''} ${n.toFixed(2)}`.trim()
const safe = (s: string) => s.replace(/[\\()]/g, c => `\\${c}`).replace(/[^\x20-\x7E]/g, '?')

export function verifiedLineTotal(line: PurchaseEvidence['lines'][number]): number | null {
  if (line.extendedPrice !== null) return line.extendedPrice
  if (line.quantity !== null && line.unitPrice !== null) return Math.round(line.quantity * line.unitPrice * 100) / 100
  return null
}

export function buildFreightDocumentData(businessName: string, request: FreightRequest, evidence: PurchaseEvidence): FreightDocumentData {
  if (!request.reference) throw new Error('A freight reference (dock receipt, warehouse number, or shipment reference) is required before document generation')
  const unresolvedFields: string[] = []
  if (!evidence.vendor) unresolvedFields.push('vendor')
  if (!evidence.purchaseDate) unresolvedFields.push('purchase date')
  if (!evidence.currency) unresolvedFields.push('currency')
  if (evidence.total === null) unresolvedFields.push('total')
  evidence.lines.forEach((line, i) => {
    if (!line.description) unresolvedFields.push(`line ${i + 1} description`)
    if (line.quantity === null) unresolvedFields.push(`line ${i + 1} quantity`)
    if (verifiedLineTotal(line) === null) unresolvedFields.push(`line ${i + 1} value`)
  })
  return {
    documentTitle: 'FREIGHT DOCUMENT', businessName, freightProvider: request.freightProvider,
    reference: request.reference, vendor: evidence.vendor, purchaseDate: evidence.purchaseDate,
    purchaseReference: evidence.receiptNumber ?? evidence.orderNumber ?? evidence.poNumber,
    lines: evidence.lines, subtotal: evidence.subtotal, tax: evidence.tax, shipping: evidence.shipping,
    total: evidence.total, currency: evidence.currency, purchaser: evidence.purchaser,
    shippingAddress: evidence.shippingAddress, unresolvedFields,
    sourceEvidence: [...evidence.provenance, ...evidence.lines.flatMap(l => l.provenance)],
  }
}

/** Minimal dependency-free PDF; values come only from verified evidence. */
export function renderFreightDocumentPdf(data: FreightDocumentData): Buffer {
  const rows = [
    data.documentTitle, data.businessName, '',
    `${FREIGHT_REFERENCE_LABELS[data.reference.kind]}: ${data.reference.value}`,
    `Freight Provider: ${data.freightProvider ?? 'UNKNOWN'}`,
    `Vendor / Source Purchase: ${data.vendor ?? 'UNKNOWN'}`,
    `Purchase Date: ${data.purchaseDate ?? 'UNKNOWN'}`,
    `Purchase Reference: ${data.purchaseReference ?? 'UNKNOWN'}`, '',
    'ITEMS / COMMODITIES',
    ...data.lines.map((l, i) => `${i + 1}. ${l.description ?? 'UNKNOWN'} | Qty ${l.quantity ?? 'UNKNOWN'} | ${money(verifiedLineTotal(l), data.currency)}`),
    '', `Subtotal: ${money(data.subtotal, data.currency)}`, `Tax: ${money(data.tax, data.currency)}`,
    `Shipping: ${money(data.shipping, data.currency)}`, `TOTAL: ${money(data.total, data.currency)}`,
    ...(data.unresolvedFields.length ? ['', `NEEDS REVIEW: ${data.unresolvedFields.join(', ')}`] : []),
  ]
  const commands = rows.slice(0, 42).map((row, i) => `BT /F1 ${i === 0 ? 17 : 10} Tf 54 ${756 - i * 16} Td (${safe(row)}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

export function prepareFreightReply(request: FreightRequest): string {
  const greeting = request.senderName ? `Hi ${request.senderName.split(/\s+/)[0]},` : 'Hello,'
  return `${greeting}\n\nAttached is the requested freight document for ${freightReferenceLabel(request.reference)}.\n\nPlease let me know if you need anything else.`
}
