export const EMAIL_DOCUMENT_TYPES = [
  'dock_receipt',
  'vendor_receipt',
  'vendor_invoice',
  'purchase_invoice',
  'order_confirmation',
  'packing_slip',
  'quote',
  'purchase_order_document',
  'freight_document',
  'freight_invoice',
  'statement',
  'unrelated_document',
  'unknown',
] as const

export type EmailDocumentType = (typeof EMAIL_DOCUMENT_TYPES)[number]

export interface FieldProvenance {
  source: 'attachment_text' | 'email_context' | 'filename'
  evidence: string
}

export interface ExtractedField<T = unknown> {
  value: T | null
  provenance: FieldProvenance[]
}

export interface PurchaseEvidenceExtraction {
  vendor: ExtractedField<string>
  purchase_date: ExtractedField<string>
  invoice_number: ExtractedField<string>
  receipt_number: ExtractedField<string>
  order_number: ExtractedField<string>
  po_number: ExtractedField<string>
  line_items: ExtractedField<Array<{ description: string; quantity: number | null; unit_price: number | null; extended_price: number | null }>>
  subtotal: ExtractedField<number>
  tax: ExtractedField<number>
  shipping: ExtractedField<number>
  total: ExtractedField<number>
  currency: ExtractedField<string>
  purchaser: ExtractedField<string>
  shipping_address: ExtractedField<string>
}

export interface DockReceiptExtraction {
  dock_receipt_number: ExtractedField<string>
  freight_provider: ExtractedField<string>
  shipment_reference: ExtractedField<string>
  destination: ExtractedField<string>
  commodity_description: ExtractedField<string>
  consolidation: ExtractedField<boolean>
  dates: ExtractedField<string[]>
  shipment_identifiers: ExtractedField<string[]>
}

export interface EmailEvidenceSemantics {
  document_type: EmailDocumentType
  confidence: number
  classification_provenance: FieldProvenance[]
  purchase: PurchaseEvidenceExtraction | null
  dock_receipt: DockReceiptExtraction | null
}

const clean = (v: string | undefined | null) => (v ?? '').replace(/\s+/g, ' ').trim()
const nullField = <T>(): ExtractedField<T> => ({ value: null, provenance: [] })

function fieldFromMatch(text: string, re: RegExp, group = 1): ExtractedField<string> {
  const match = text.match(re)
  const value = clean(match?.[group])
  return value ? { value, provenance: [{ source: 'attachment_text', evidence: clean(match?.[0]).slice(0, 240) }] } : nullField<string>()
}

function numberField(text: string, label: string): ExtractedField<number> {
  const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:#-]?\\s*(?:USD|BSD|US\\$|B\\$|\\$)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`, 'im')
  const match = text.match(re)
  if (!match) return nullField<number>()
  const value = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(value)
    ? { value, provenance: [{ source: 'attachment_text', evidence: clean(match[0]).slice(0, 240) }] }
    : nullField<number>()
}

function stringList(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(clean).filter(Boolean))]
}

export function classifyEmailDocument(input: { filename?: string | null; subject?: string | null; text?: string | null }): Pick<EmailEvidenceSemantics, 'document_type' | 'confidence' | 'classification_provenance'> {
  const filename = clean(input.filename).toLowerCase()
  const subject = clean(input.subject).toLowerCase()
  const text = clean(input.text).toLowerCase()
  const haystack = `${filename}\n${subject}\n${text}`
  const proof = (needle: string): FieldProvenance[] => [{ source: text.includes(needle) ? 'attachment_text' : filename.includes(needle) ? 'filename' : 'email_context', evidence: needle }]

  // Strong semantic identities first. A dock receipt must never fall through to
  // generic receipt/invoice handling merely because humans reused the noun.
  if (/\bdock\s+receipt\b/.test(haystack)) return { document_type: 'dock_receipt', confidence: 0.99, classification_provenance: proof('dock receipt') }
  if (/\bpacking\s+(?:slip|list)\b/.test(haystack)) return { document_type: 'packing_slip', confidence: 0.98, classification_provenance: proof('packing slip') }
  if (/\b(?:quote|quotation|estimate)\b/.test(haystack)) return { document_type: 'quote', confidence: 0.97, classification_provenance: proof(haystack.includes('quotation') ? 'quotation' : haystack.includes('estimate') ? 'estimate' : 'quote') }
  if (/\bpurchase\s+order\b|\bpo\s*(?:number|no\.?|#)\b/.test(haystack)) return { document_type: 'purchase_order_document', confidence: 0.94, classification_provenance: proof('purchase order') }
  if (/\border\s+confirmation\b|\bthank you for your order\b/.test(haystack)) return { document_type: 'order_confirmation', confidence: 0.96, classification_provenance: proof('order confirmation') }
  if (/\bfreight\s+invoice\b|\bcarrier\s+invoice\b/.test(haystack)) return { document_type: 'freight_invoice', confidence: 0.97, classification_provenance: proof('freight invoice') }
  if (/\bstatement\s+of\s+account\b|\baccount\s+statement\b/.test(haystack)) return { document_type: 'statement', confidence: 0.96, classification_provenance: proof('statement') }

  const incomingVendor = /\b(home depot|amazon|supplier|vendor|merchant|sold by)\b/.test(haystack)
  if (/\b(?:sales\s+)?receipt\b|\btransaction\s+receipt\b/.test(haystack)) return { document_type: 'vendor_receipt', confidence: incomingVendor ? 0.96 : 0.86, classification_provenance: proof('receipt') }
  if (/\binvoice\b/.test(haystack)) return { document_type: incomingVendor ? 'vendor_invoice' : 'purchase_invoice', confidence: incomingVendor ? 0.94 : 0.78, classification_provenance: proof('invoice') }
  if (/\b(bill of lading|shipment manifest|freight document|cargo manifest)\b/.test(haystack)) return { document_type: 'freight_document', confidence: 0.94, classification_provenance: proof('shipment') }
  if (/\b(brochure|catalog(?:ue)?|marketing material|company profile)\b/.test(haystack)) return { document_type: 'unrelated_document', confidence: 0.94, classification_provenance: proof('brochure') }
  return { document_type: 'unknown', confidence: 0.35, classification_provenance: [] }
}

function extractLineItems(text: string): ExtractedField<PurchaseEvidenceExtraction['line_items']['value'] extends infer T ? NonNullable<T> : never> {
  const rows: Array<{ description: string; quantity: number | null; unit_price: number | null; extended_price: number | null }> = []
  const evidence: FieldProvenance[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // Conservative fixture-friendly row: description | qty | unit | extended.
    // We only emit a row when at least quantity + extended amount are explicit.
    const m = line.match(/^(.{2,100}?)\s{2,}|^(.{2,100}?)\s+\|\s*/)
    if (!m) continue
    const parts = line.includes('|') ? line.split('|').map(x => x.trim()) : line.split(/\s{2,}/).map(x => x.trim())
    if (parts.length < 3) continue
    const amount = (s: string) => {
      const v = Number(s.replace(/[^0-9.-]/g, ''))
      return Number.isFinite(v) ? v : null
    }
    const quantity = amount(parts[1])
    const extended = amount(parts[parts.length - 1])
    if (quantity == null || extended == null) continue
    const unit = parts.length >= 4 ? amount(parts[2]) : null
    rows.push({ description: parts[0], quantity, unit_price: unit, extended_price: extended })
    evidence.push({ source: 'attachment_text', evidence: line.slice(0, 240) })
  }
  return { value: rows, provenance: evidence }
}

export function extractPurchaseEvidence(textInput: string): PurchaseEvidenceExtraction {
  const text = textInput || ''
  const currencyMatch = text.match(/\b(USD|BSD|EUR|GBP|CAD)\b|(?:US\$|\$)\s*[0-9]/i)
  const currency = currencyMatch
    ? { value: currencyMatch[1]?.toUpperCase() || 'USD', provenance: [{ source: 'attachment_text' as const, evidence: clean(currencyMatch[0]) }] }
    : nullField<string>()

  return {
    vendor: fieldFromMatch(text, /(?:vendor|merchant|seller|sold by)\s*[:#-]?\s*([^\n]+)/i),
    purchase_date: fieldFromMatch(text, /(?:purchase date|order date|invoice date|receipt date|date)\s*[:#-]?\s*([^\n]+)/i),
    invoice_number: fieldFromMatch(text, /(?:invoice\s*(?:number|no\.?|#))\s*[:#-]?\s*([A-Z0-9-]+)/i),
    receipt_number: fieldFromMatch(text, /(?:receipt\s*(?:number|no\.?|#))\s*[:#-]?\s*([A-Z0-9-]+)/i),
    order_number: fieldFromMatch(text, /(?:order\s*(?:number|no\.?|#))\s*[:#-]?\s*([A-Z0-9-]+)/i),
    po_number: fieldFromMatch(text, /(?:purchase order|PO)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9-]+)/i),
    line_items: extractLineItems(text),
    subtotal: numberField(text, 'subtotal'),
    tax: numberField(text, 'tax'),
    shipping: numberField(text, '(?:shipping|freight)'),
    total: numberField(text, '(?:grand\\s+)?total'),
    currency,
    purchaser: fieldFromMatch(text, /(?:purchaser|buyer|bill to)\s*[:#-]?\s*([^\n]+)/i),
    shipping_address: fieldFromMatch(text, /(?:ship to|shipping address|delivery address)\s*[:#-]?\s*([^\n]+)/i),
  }
}

export function extractDockReceipt(textInput: string): DockReceiptExtraction {
  const text = textInput || ''
  const dates = stringList([...text.matchAll(/\b(?:0?[1-9]|1[0-2])[\/-](?:0?[1-9]|[12]\d|3[01])[\/-](?:20)?\d{2}\b/g)].map(m => m[0]))
  const identifiers = stringList([...text.matchAll(/\b(?:booking|shipment|container|BOL|bill of lading)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9-]{4,})/gi)].map(m => m[1]))
  const consolidation = /\b(consolidat(?:e|ed|ion)|LCL)\b/i.test(text)
  const consolidationEvidence = text.match(/\b(consolidat(?:e|ed|ion)|LCL)\b/i)?.[0]
  return {
    dock_receipt_number: fieldFromMatch(text, /(?:dock\s+receipt)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([A-Z0-9-]+)/i),
    freight_provider: fieldFromMatch(text, /(?:freight provider|carrier|steamship line)\s*[:#-]?\s*([^\n]+)/i),
    shipment_reference: fieldFromMatch(text, /(?:shipment|booking)\s*(?:reference|ref\.?|number|no\.?|#)\s*[:#-]?\s*([A-Z0-9-]+)/i),
    destination: fieldFromMatch(text, /(?:destination|port of discharge)\s*[:#-]?\s*([^\n]+)/i),
    commodity_description: fieldFromMatch(text, /(?:commodity|description of goods|cargo)\s*[:#-]?\s*([^\n]+)/i),
    consolidation: { value: consolidation, provenance: consolidationEvidence ? [{ source: 'attachment_text', evidence: consolidationEvidence }] : [] },
    dates: { value: dates, provenance: dates.map(value => ({ source: 'attachment_text', evidence: value })) },
    shipment_identifiers: { value: identifiers, provenance: identifiers.map(value => ({ source: 'attachment_text', evidence: value })) },
  }
}

export function analyzeEmailDocument(input: { filename?: string | null; subject?: string | null; text?: string | null }): EmailEvidenceSemantics {
  const classification = classifyEmailDocument(input)
  const text = input.text || ''
  const purchaseTypes: EmailDocumentType[] = ['vendor_receipt', 'vendor_invoice', 'purchase_invoice', 'order_confirmation']
  return {
    ...classification,
    purchase: purchaseTypes.includes(classification.document_type) ? extractPurchaseEvidence(text) : null,
    dock_receipt: classification.document_type === 'dock_receipt' ? extractDockReceipt(text) : null,
  }
}

export function isTrustedPurchaseEvidenceType(type: EmailDocumentType): boolean {
  return type === 'vendor_receipt' || type === 'vendor_invoice' || type === 'purchase_invoice' || type === 'order_confirmation'
}
