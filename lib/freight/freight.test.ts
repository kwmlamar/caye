import { describe, expect, it } from 'vitest'
import { detectFreightRequest } from './detection'
import { buildFreightDocumentData, prepareFreightReply, renderFreightDocumentPdf, verifiedLineTotal } from './document'
import { KING_OCEAN_FIXTURE, TWINEX_FIXTURE } from './fixture'
import { rankPurchaseEvidence } from './matching'
import { FREIGHT_REFERENCE_LABELS, freightReferenceLabel } from './types'
import type { PurchaseEvidence } from './types'
import { purchaseEvidenceFromBedrockReceipt, purchaseEvidenceFromObservation } from './evidence'

const evidence = (overrides: Partial<PurchaseEvidence> = {}): PurchaseEvidence => ({ ...KING_OCEAN_FIXTURE.evidence, ...overrides })
const twinexEvidence = (overrides: Partial<PurchaseEvidence> = {}): PurchaseEvidence => ({ ...TWINEX_FIXTURE.evidence, ...overrides })

describe('freight request detection', () => {
  it('detects a generic freight invoice request and extracts the dock receipt', () => {
    const r = detectFreightRequest({ subject: 'Dock Receipt DR-12345', body: 'Please send an INVOICE referencing the dock receipt number. Alert us if this is a cargo consolidation.', from: 'Nicole Butcher <nicole@carrier.test>' })
    expect(r.isFreightDocumentRequest).toBe(true)
    expect(r.reference).toEqual({ kind: 'dock_receipt', value: 'DR-12345' })
    expect(r.dockReceiptNumber).toBe('DR-12345')
    expect(r.consolidationMentioned).toBe(true)
    expect(r.senderEmail).toBe('nicole@carrier.test')
  })

  it('does not classify an ordinary invoice email as freight', () => {
    expect(detectFreightRequest({ subject: 'Monthly invoice', body: 'Your invoice is attached.' }).isFreightDocumentRequest).toBe(false)
  })

  it('detects a realistic TWINex warehouse-number request the same way it detects a dock receipt', () => {
    const r = detectFreightRequest({
      subject: 'Warehouse #188052 - commercial invoice needed',
      body: 'Hi, please send the commercial invoice for warehouse #188052 so we can clear this shipment. Thanks, Keisha',
      from: 'Keisha <keisha@twinex.example.test>',
    })
    expect(r.isFreightDocumentRequest).toBe(true)
    expect(r.reference).toEqual({ kind: 'warehouse_number', value: '188052' })
    expect(r.dockReceiptNumber).toBeNull()
  })

  it.each([
    ['warehouse no. 188052'],
    ['WH# 188052'],
    ['warehouse number 188052'],
  ])('recognizes the warehouse-number form "%s"', (form) => {
    const r = detectFreightRequest({ subject: 'Freight document request', body: `Please send the commercial invoice, ${form}.` })
    expect(r.isFreightDocumentRequest).toBe(true)
    expect(r.reference?.kind).toBe('warehouse_number')
    expect(r.reference?.value).toBe('188052')
  })

  it('does not trigger on a document word with no request language and no reference', () => {
    const r = detectFreightRequest({ subject: 'FYI', body: 'Your commercial invoice for the cargo shipment is on file for your records.' })
    expect(r.isFreightDocumentRequest).toBe(false)
    expect(r.reference).toBeNull()
    expect(r.evidence).toEqual([])
  })
})

describe('purchase evidence matching', () => {
  it('makes an exact reference match high confidence', () => {
    const result = rankPurchaseEvidence(KING_OCEAN_FIXTURE.request, [evidence()])
    expect(result.status).toBe('MATCH_FOUND')
    expect(result.selection?.confidence).toBe('HIGH')
  })

  it('keeps two plausible receipts ambiguous', () => {
    const result = rankPurchaseEvidence(KING_OCEAN_FIXTURE.request, [evidence({ id: 'a' }), evidence({ id: 'b' })])
    expect(result.status).toBe('AMBIGUOUS')
    expect(result.selection).toBeNull()
  })

  it('returns unresolved rather than inventing a match', () => {
    const candidate = evidence({ referenceNumbers: [], orderNumber: null, purchaseDate: '2025-01-01', lines: [], total: null })
    const result = rankPurchaseEvidence(KING_OCEAN_FIXTURE.request, [candidate])
    expect(result.status).toBe('NO_MATCH')
    expect(result.selection).toBeNull()
  })

  it('makes an exact reference match high confidence for a warehouse-number request too', () => {
    const result = rankPurchaseEvidence(TWINEX_FIXTURE.request, [twinexEvidence()])
    expect(result.status).toBe('MATCH_FOUND')
    expect(result.selection?.confidence).toBe('HIGH')
    expect(result.selection?.reasons).toContain('exact reference match')
  })
})

describe('verified document generation', () => {
  it('extracts only present receipt fields and keeps field provenance', () => {
    const parsed = purchaseEvidenceFromObservation({ workspaceId: 'w', artifactId: 'a', content: { vendor: 'Home Depot', line_items: [{ description: 'Lumber', quantity: 2 }], total: '19.50' } })
    expect(parsed.vendor).toBe('Home Depot'); expect(parsed.lines[0].quantity).toBe(2); expect(parsed.lines[0].unitPrice).toBeNull(); expect(parsed.total).toBe(19.5)
    expect(parsed.lines[0].provenance[0].field).toBe('line_items[0]')
  })

  it('converts Bedrock receipts through its read-only shape without write operations', () => {
    const parsed = purchaseEvidenceFromBedrockReceipt({ sourceSystem: 'bedrock', authority: 'external_authoritative', sourceEntityType: 'receipt', sourceEntityId: 'r1', id: 'r1', workspaceId: 'w', companyId: 'co', projectId: 'p', vendorNameSnapshot: 'Vendor', receiptDate: '2026-08-30', totalAmount: 12, status: 'approved', items: [{ id: 'i', materialId: null, name: 'Nails', quantity: 3, unit: 'box', cost: 12 }] })
    expect(parsed.source).toBe('bedrock'); expect(parsed.total).toBe(12); expect(Object.keys(parsed)).not.toContain('update')
  })
  it('preserves lines, quantities, totals and provenance', () => {
    const data = buildFreightDocumentData('ODS Construction', KING_OCEAN_FIXTURE.request, evidence())
    expect(data.lines[0].quantity).toBe(20)
    expect(data.total).toBe(522.5)
    expect(data.sourceEvidence.some(p => p.id === 'msg-receipt-1')).toBe(true)
  })

  it('keeps missing required values unresolved', () => {
    const data = buildFreightDocumentData('ODS Construction', KING_OCEAN_FIXTURE.request, evidence({ vendor: null, total: null }))
    expect(data.vendor).toBeNull()
    expect(data.unresolvedFields).toContain('vendor')
    expect(data.unresolvedFields).toContain('total')
  })

  it('uses deterministic arithmetic only when inputs are verified', () => {
    expect(verifiedLineTotal({ description: 'x', quantity: 3, unitPrice: 2.25, extendedPrice: null, provenance: [] })).toBe(6.75)
    expect(verifiedLineTotal({ description: 'x', quantity: null, unitPrice: 2.25, extendedPrice: null, provenance: [] })).toBeNull()
  })

  it('renders the dock receipt and identifies itself as freight, never AR', () => {
    const data = buildFreightDocumentData('ODS Construction', KING_OCEAN_FIXTURE.request, evidence())
    const pdf = renderFreightDocumentPdf(data).toString('latin1')
    expect(pdf).toContain('Dock Receipt: DR-12345')
    expect(pdf).toContain('FREIGHT DOCUMENT')
    expect(pdf).not.toContain('accounts receivable')
  })

  it('does not leak internal matching taxonomy in the external reply', () => {
    const reply = prepareFreightReply(KING_OCEAN_FIXTURE.request)
    expect(reply).toContain('DR-12345')
    expect(reply).not.toMatch(/HIGH|MEDIUM|confidence|taxonomy|score/)
  })

  it('generates and renders a TWINex request with Warehouse wording, and never the word Dock', () => {
    const data = buildFreightDocumentData('ODS Construction', TWINEX_FIXTURE.request, twinexEvidence())
    expect(data.reference).toEqual({ kind: 'warehouse_number', value: '188052' })
    const pdf = renderFreightDocumentPdf(data).toString('latin1')
    expect(pdf).toContain('Warehouse: 188052')
    expect(pdf).not.toMatch(/dock/i)

    const reply = prepareFreightReply(TWINEX_FIXTURE.request)
    expect(reply).toContain('Warehouse 188052')
    expect(reply).not.toMatch(/dock/i)
    expect(reply).not.toContain('UNKNOWN')
  })

  it('renders the King Ocean reply exactly as before -- regression', () => {
    const reply = prepareFreightReply(KING_OCEAN_FIXTURE.request)
    expect(reply).toContain('Dock Receipt DR-12345')
    expect(reply).not.toContain('UNKNOWN')
  })

  it('throws a clear error instead of generating a document with no reference of any kind', () => {
    const requestWithoutReference = { ...KING_OCEAN_FIXTURE.request, reference: null, dockReceiptNumber: null }
    expect(() => buildFreightDocumentData('ODS Construction', requestWithoutReference, evidence())).toThrow(/reference/i)
  })

  it('labels each reference kind directly, so a future forwarder cannot silently inherit the wrong label', () => {
    expect(FREIGHT_REFERENCE_LABELS.dock_receipt).toBe('Dock Receipt')
    expect(FREIGHT_REFERENCE_LABELS.warehouse_number).toBe('Warehouse')
    expect(freightReferenceLabel({ kind: 'dock_receipt', value: 'DR-12345' })).toBe('Dock Receipt DR-12345')
    expect(freightReferenceLabel({ kind: 'warehouse_number', value: '188052' })).toBe('Warehouse 188052')
    expect(freightReferenceLabel({ kind: 'shipment_ref', value: 'SHP-1' })).toBe('Shipment Reference SHP-1')
    expect(freightReferenceLabel(null)).toBe('UNKNOWN')
  })
})
