import { describe, expect, it } from 'vitest'
import { analyzeEmailDocument, isTrustedPurchaseEvidenceType } from './email-evidence-semantics'

describe('email attachment evidence semantics', () => {
  it('classifies and extracts King Ocean dock receipt DR-12345', () => {
    const result = analyzeEmailDocument({
      filename: 'DOCK_RECEIPT_DR-12345.pdf',
      subject: 'Please see attached DOCK RECEIPT',
      text: [
        'KING OCEAN SERVICES',
        'DOCK RECEIPT NUMBER: DR-12345',
        'Carrier: King Ocean Services',
        'Shipment Reference: KO-55190',
        'Destination: Nassau, Bahamas',
        'Commodity: construction materials',
        'Consolidation: LCL',
        '09/02/2026',
      ].join('\n'),
    })
    expect(result.document_type).toBe('dock_receipt')
    expect(result.dock_receipt?.dock_receipt_number.value).toBe('DR-12345')
    expect(result.dock_receipt?.shipment_reference.value).toBe('KO-55190')
    expect(result.dock_receipt?.destination.value).toBe('Nassau, Bahamas')
    expect(result.dock_receipt?.consolidation.value).toBe(true)
    expect(result.dock_receipt?.dock_receipt_number.provenance.length).toBeGreaterThan(0)
    expect(isTrustedPurchaseEvidenceType(result.document_type)).toBe(false)
  })

  it('classifies Home Depot receipt and extracts explicit purchase facts without invented arithmetic', () => {
    const result = analyzeEmailDocument({
      filename: 'home-depot-HD-8891.pdf',
      subject: 'Your Home Depot receipt',
      text: [
        'THE HOME DEPOT',
        'Vendor: Home Depot',
        'RECEIPT NUMBER: HD-8891',
        'Purchase Date: 09/01/2026',
        '2x4 Lumber | 10 | 8.50 | 85.00',
        'Concrete Mix | 5 | 12.00 | 60.00',
        'Subtotal: 145.00',
        'Tax: 17.40',
        'Shipping: 25.00',
        'Total: USD 187.40',
        'Purchaser: ODS Construction',
        'Ship To: Lower Bogue, Eleuthera',
      ].join('\n'),
    })
    expect(result.document_type).toBe('vendor_receipt')
    expect(result.purchase?.vendor.value).toBe('Home Depot')
    expect(result.purchase?.receipt_number.value).toBe('HD-8891')
    expect(result.purchase?.line_items.value).toHaveLength(2)
    expect(result.purchase?.line_items.value?.[0]).toMatchObject({ quantity: 10, unit_price: 8.5, extended_price: 85 })
    expect(result.purchase?.subtotal.value).toBe(145)
    expect(result.purchase?.tax.value).toBe(17.4)
    expect(result.purchase?.shipping.value).toBe(25)
    expect(result.purchase?.total.value).toBe(187.4)
    expect(result.purchase?.currency.value).toBe('USD')
    expect(result.purchase?.total.provenance.length).toBeGreaterThan(0)
    expect(isTrustedPurchaseEvidenceType(result.document_type)).toBe(true)
  })

  it('does not treat a vendor quote as completed purchase evidence', () => {
    const result = analyzeEmailDocument({ filename: 'supplier-quote-Q-42.pdf', text: 'Vendor: ABC Supply\nQUOTE Q-42\nTotal: $900.00' })
    expect(result.document_type).toBe('quote')
    expect(result.purchase).toBeNull()
    expect(isTrustedPurchaseEvidenceType(result.document_type)).toBe(false)
  })

  it('classifies packing slips separately from purchase evidence', () => {
    const result = analyzeEmailDocument({ filename: 'packing-slip.pdf', text: 'PACKING SLIP\nOrder Number: 22119\n5 cartons' })
    expect(result.document_type).toBe('packing_slip')
    expect(result.purchase).toBeNull()
    expect(isTrustedPurchaseEvidenceType(result.document_type)).toBe(false)
  })

  it('classifies an unrelated brochure without manufacturing purchase fields', () => {
    const result = analyzeEmailDocument({ filename: 'company-brochure.pdf', text: 'COMPANY BROCHURE\nOur services and locations' })
    expect(result.document_type).toBe('unrelated_document')
    expect(result.purchase).toBeNull()
    expect(result.dock_receipt).toBeNull()
  })

  it('preserves unknown when evidence is weak', () => {
    const result = analyzeEmailDocument({ filename: 'scan-001.pdf', text: 'Reference material' })
    expect(result.document_type).toBe('unknown')
    expect(result.confidence).toBeLessThan(0.5)
  })
})
