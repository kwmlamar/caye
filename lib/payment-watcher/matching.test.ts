import { describe, expect, it } from 'vitest'
import { rankInvoiceMatches } from './matching'
import type { InvoiceCandidate, PaymentSignal } from './types'

function signal(overrides: Partial<PaymentSignal> = {}): PaymentSignal {
  return {
    isPaymentSignal: true,
    direction: 'inbound',
    amount: 1000,
    reference: null,
    senderName: 'Eric',
    senderEmail: 'eric@clientdomain.example',
    senderDomain: 'clientdomain.example',
    isBankSender: false,
    evidence: [],
    ...overrides,
  }
}

function invoice(overrides: Partial<InvoiceCandidate> = {}): InvoiceCandidate {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-100',
    clientName: 'Eric',
    balanceDue: 1000,
    clientEmailDomain: 'clientdomain.example',
    ...overrides,
  }
}

describe('invoice matching', () => {
  it('matches exactly when the amount equals a single client-matched invoice balance', () => {
    const result = rankInvoiceMatches(signal(), [invoice()])
    expect(result.status).toBe('MATCHED')
    expect(result.selection?.confidence).toBe('EXACT')
    expect(result.selection?.candidate.id).toBe('inv-1')
  })

  it('matches partially when the amount is less than the balance due', () => {
    const result = rankInvoiceMatches(signal({ amount: 400 }), [invoice({ balanceDue: 1000 })])
    expect(result.status).toBe('MATCHED')
    expect(result.selection?.confidence).toBe('PARTIAL')
  })

  it('never picks between two plausible invoices for the same client', () => {
    const result = rankInvoiceMatches(signal({ amount: 400 }), [
      invoice({ id: 'inv-1', balanceDue: 1000 }),
      invoice({ id: 'inv-2', balanceDue: 500 }),
    ])
    expect(result.status).toBe('AMBIGUOUS')
    expect(result.selection).toBeNull()
    expect(result.candidates).toHaveLength(2)
  })

  it('reports no match rather than guessing when no invoice belongs to this sender', () => {
    const result = rankInvoiceMatches(signal(), [
      invoice({ clientName: 'Someone Else', clientEmailDomain: 'other.example' }),
    ])
    expect(result.status).toBe('NO_MATCH')
    expect(result.selection).toBeNull()
  })

  it('does not treat an amount exceeding a single invoice balance as a match for it', () => {
    const result = rankInvoiceMatches(signal({ amount: 5000 }), [invoice({ balanceDue: 1000 })])
    expect(result.status).toBe('NO_MATCH')
  })

  it('matches by exact reference number even without a name/domain overlap', () => {
    const result = rankInvoiceMatches(
      signal({ reference: 'INV-100', senderName: 'Different Name', senderDomain: 'unrelated.example' }),
      [invoice({ invoiceNumber: 'INV-100', clientName: 'Eric', clientEmailDomain: 'clientdomain.example' })]
    )
    expect(result.status).toBe('MATCHED')
  })

  it('matches by sender email domain when the name differs', () => {
    const result = rankInvoiceMatches(
      signal({ senderName: 'A. Nickname', senderDomain: 'clientdomain.example' }),
      [invoice({ clientName: 'Eric Formal Co.', clientEmailDomain: 'clientdomain.example' })]
    )
    expect(result.status).toBe('MATCHED')
  })

  it('ignores an invoice belonging to a different client even if the amount matches exactly', () => {
    const result = rankInvoiceMatches(signal({ amount: 1000 }), [
      invoice({ clientName: 'Someone Else', clientEmailDomain: 'other.example', balanceDue: 1000 }),
    ])
    expect(result.status).toBe('NO_MATCH')
  })
})
