import { describe, expect, it } from 'vitest'
import { detectPaymentSignal } from './detection'

describe('payment signal detection', () => {
  it('detects a bank deposit alert as an inbound payment signal', () => {
    const r = detectPaymentSignal({
      subject: 'RBC Alert: Deposit Notification',
      body: 'A deposit of $3,200.00 has been made to your account ending 4821.',
      from: 'RBC Royal Bank <alerts@rbcroyalbank.com>',
    })
    expect(r.isPaymentSignal).toBe(true)
    expect(r.direction).toBe('inbound')
    expect(r.amount).toBe(3200)
    expect(r.isBankSender).toBe(true)
  })

  it('detects a client email saying money was wired', () => {
    const r = detectPaymentSignal({
      subject: 'Payment sent',
      body: 'Hi, we wired $1,500.00 to your account today for invoice INV-102. Let us know once received.',
      from: 'Eric <eric@clientdomain.example>',
    })
    expect(r.isPaymentSignal).toBe(true)
    expect(r.direction).toBe('inbound')
    expect(r.amount).toBe(1500)
    expect(r.reference).toBe('INV-102')
    expect(r.senderName).toBe('Eric')
    expect(r.isBankSender).toBe(false)
  })

  it('does not classify a supplier invoice to ODS as a payment signal (accounts payable, not receivable)', () => {
    const r = detectPaymentSignal({
      subject: 'Invoice attached',
      body: 'Please find attached our invoice for $4,200.00. Payment is due net 30.',
      from: 'Supplier <billing@supplier.example>',
    })
    expect(r.isPaymentSignal).toBe(false)
    expect(r.direction).toBe('outbound')
    expect(r.amount).toBeNull()
  })

  it('does not treat a bare dollar figure with no payment language as a signal', () => {
    const r = detectPaymentSignal({
      subject: 'Estimate',
      body: 'The estimate for this job comes to $4,200.00 depending on materials.',
      from: 'Someone <someone@example.com>',
    })
    expect(r.isPaymentSignal).toBe(false)
    expect(r.direction).toBe('unknown')
  })

  it('requires the amount to be near the inbound phrase, not merely present anywhere in the email', () => {
    const r = detectPaymentSignal({
      subject: 'Two invoices',
      body:
        'Invoice INV-200 for $9,999.00 is still open and unpaid. ' +
        'Separately, we wired $500.00 today for INV-099 — that one is settled.',
      from: 'Client <client@example.com>',
    })
    expect(r.isPaymentSignal).toBe(true)
    expect(r.amount).toBe(500)
  })

  it('prefers outbound classification when an outbound marker sits nearer the amount than any inbound phrase', () => {
    const r = detectPaymentSignal({
      subject: 'Invoice',
      body: 'Our invoice attached: amount due is $4,200.00. We previously wired money for other jobs.',
      from: 'Supplier <billing@supplier.example>',
    })
    expect(r.isPaymentSignal).toBe(false)
    expect(r.direction).toBe('outbound')
  })
})
