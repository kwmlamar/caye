import type { FreightRequest, FreightReference } from './types'

const DOCK_RECEIPT = /\b(?:dock\s*(?:receipt|rec(?:ei)?pt)|d\.?r\.?)\s*(?:no\.?|number|#|:)??\s*([A-Z0-9][A-Z0-9-]{2,})\b/i
// TWINex issues a warehouse number rather than a dock receipt; same request, different label. Forms seen
// in real ODS mail: "warehouse #188052", "warehouse no. 188052", "WH# 188052", "warehouse number 188052".
const WAREHOUSE_NUMBER = /\b(?:warehouse\s*(?:no\.?|number)?\s*#?|wh\s*#)\s*(?:no\.?|number|:)?\s*([A-Z0-9][A-Z0-9-]{2,})\b/i
const SHIPMENT_REF = /\b(?:shipment|booking|bill\s+of\s+lading|BOL)\s*(?:no\.?|number|#|:)?\s*([A-Z0-9][A-Z0-9-]{2,})\b/i
const DOCUMENT_WORDS = /\b(invoice|commercial invoice|customs invoice|purchase declaration|shipment invoice)\b/i
const FREIGHT_WORDS = /\b(freight|cargo|shipment|shipping|dock receipt|warehouse|bill of lading|carrier|consolidation)\b/i
const REQUEST_WORDS = /\b(please|send|provide|need|request|required|attach|submit)\b/i

function senderName(from: string | null | undefined): string | null {
  if (!from) return null
  const before = from.split('<')[0].trim().replace(/^['"]|['"]$/g, '')
  return before && !before.includes('@') ? before : null
}

function senderEmail(from: string | null | undefined): string | null {
  if (!from) return null
  return from.match(/<?([\w.+-]+@[\w.-]+)>?/i)?.[1]?.toLowerCase() ?? null
}

/** Deterministic, evidence-bearing gate. An invoice mention by itself is not freight. */
export function detectFreightRequest(input: {
  subject?: string | null
  body?: string | null
  from?: string | null
  receivedAt?: string | null
}): FreightRequest {
  const text = `${input.subject ?? ''}\n${input.body ?? ''}`.replace(/\s+/g, ' ').trim()
  const dock = text.match(DOCK_RECEIPT)?.[1] ?? null
  const warehouse = text.match(WAREHOUSE_NUMBER)?.[1] ?? null
  const shipment = text.match(SHIPMENT_REF)?.[1] ?? null
  const document = text.match(DOCUMENT_WORDS)?.[1]?.toLowerCase() ?? null
  const freight = FREIGHT_WORDS.test(text)
  const requested = REQUEST_WORDS.test(text)

  // Precedence when a message somehow carries more than one reference form: dock receipt and warehouse
  // number are each forwarder-specific and mutually exclusive in practice, so either one wins over a
  // generic shipment/booking/BOL reference.
  const reference: FreightReference | null = dock
    ? { kind: 'dock_receipt', value: dock }
    : warehouse
    ? { kind: 'warehouse_number', value: warehouse }
    : shipment
    ? { kind: 'shipment_ref', value: shipment }
    : null

  const evidence: string[] = []
  if (dock) evidence.push(`dock_receipt:${dock}`)
  if (warehouse) evidence.push(`warehouse_number:${warehouse}`)
  if (shipment) evidence.push(`shipment_reference:${shipment}`)
  if (document) evidence.push(`requested_document:${document}`)
  if (freight) evidence.push('freight_language')
  if (requested) evidence.push('request_language')

  const isFreightDocumentRequest = Boolean(document && requested && (reference || freight))
  return {
    isFreightDocumentRequest,
    evidence: isFreightDocumentRequest ? evidence : [],
    freightProvider: senderName(input.from),
    senderName: senderName(input.from),
    senderEmail: senderEmail(input.from),
    reference,
    dockReceiptNumber: reference?.kind === 'dock_receipt' ? reference.value : null,
    shipmentReference: reference?.kind === 'shipment_ref' ? reference.value : null,
    requestedDocument: document,
    consolidationMentioned: /\bconsolidat(?:e|ed|ion|ing)\b/i.test(text),
    destination: text.match(/\b(?:destination|deliver(?:y|ed)?\s+to|ship\s+to)\s*[:\-]?\s*([^.;\n]{3,100})/i)?.[1]?.trim() ?? null,
    commodities: [...text.matchAll(/\b(?:commodit(?:y|ies)|cargo)\s*[:\-]\s*([^.;\n]{3,100})/gi)].map(m => m[1].trim()),
    requestedAt: input.receivedAt ?? null,
  }
}

