import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'workspace_ai_config') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { operator_whatsapp_number: '+12425551234' }, error: null }),
          }),
        }),
      }
    },
  }),
}))

vi.mock('@/lib/operator-identity', () => ({
  resolveOperatorByPhone: vi.fn(async () => ({ id: 7, name: 'Wallace', role: 'owner' })),
}))

const observeAttentionItem = vi.fn(async (_args: Record<string, unknown>) => null)
vi.mock('@/lib/owner-attention', () => ({ observeAttentionItem }))

const gatedExecute = vi.fn(async () => ({
  ok: true,
  data: { pending_action_id: 'pa-1', summary: 'Record a $1000.00 payment' },
}))
vi.mock('@/lib/caye-agent/tools/high-risk-gate', () => ({
  gateHighRisk: () => ({ execute: gatedExecute }),
}))
vi.mock('@/lib/caye-agent/tools/write-high/record-payment', () => ({ recordPayment: {} }))

const { proposePaymentMatch } = await import('./propose')

const BASE = {
  workspaceId: 'ws-1',
  messageId: 'gmail-1',
  threadId: 'thread-1',
  receivedAt: '2026-09-04T17:00:00.000Z',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeAdapter(invoices: Array<Record<string, unknown>>, clients: Array<Record<string, unknown>> = []): any {
  return {
    getAdapter: () => ({
      listInvoices: vi.fn(async () => invoices),
      listClients: vi.fn(async () => clients),
    }),
  }
}

beforeEach(() => {
  observeAttentionItem.mockClear()
  gatedExecute.mockClear()
})

describe('proposePaymentMatch', () => {
  it('does nothing when the email is not a payment signal', async () => {
    const deps = fakeAdapter([])
    const outcome = await proposePaymentMatch(
      { ...BASE, subject: 'Meeting notes', body: 'See you Tuesday.', from: 'Someone <someone@example.com>' },
      deps
    )
    expect(outcome).toMatchObject({ staged: false, reason: 'not_a_payment_signal' })
    expect(observeAttentionItem).not.toHaveBeenCalled()
    expect(gatedExecute).not.toHaveBeenCalled()
  })

  it('stages record_payment and raises attention with the pending_action_id when exactly one invoice matches', async () => {
    const deps = fakeAdapter([
      {
        id: 'inv-1',
        invoiceNumber: 'INV-100',
        clientName: 'Eric',
        balanceDue: 1000,
        sentAt: '2026-08-01',
        totalAmount: 1000,
        amountPaid: 0,
      },
    ])
    const outcome = await proposePaymentMatch(
      {
        ...BASE,
        subject: 'Payment sent',
        body: 'Hi, we wired $1,000.00 to your account today for invoice INV-100.',
        from: 'Eric <eric@clientdomain.example>',
      },
      deps
    )
    expect(outcome).toMatchObject({ staged: 'matched', pendingActionId: 'pa-1', invoiceId: 'inv-1' })
    expect(gatedExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice_id: 'inv-1',
        amount: 1000,
        payment_method: 'bank_transfer',
        payment_date: '2026-09-04',
      }),
      expect.objectContaining({ workspaceId: 'ws-1', origin: 'scan' })
    )
    expect(observeAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'payment_signal',
        subjectId: 'gmail-1',
        nextAction: expect.stringContaining('pa-1'),
      })
    )
  })

  it('raises an ambiguous item listing every candidate and stages nothing', async () => {
    const deps = fakeAdapter([
      { id: 'inv-1', invoiceNumber: 'INV-100', clientName: 'Eric', balanceDue: 1000, sentAt: '2026-08-01' },
      { id: 'inv-2', invoiceNumber: 'INV-101', clientName: 'Eric', balanceDue: 500, sentAt: '2026-08-05' },
    ])
    const outcome = await proposePaymentMatch(
      {
        ...BASE,
        subject: 'Payment sent',
        body: 'Hi, we wired $400.00 to your account today.',
        from: 'Eric <eric@clientdomain.example>',
      },
      deps
    )
    expect(outcome).toMatchObject({ staged: 'ambiguous' })
    expect(gatedExecute).not.toHaveBeenCalled()
    expect(observeAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: 'payment_signal',
        nextAction: expect.stringMatching(/INV-100/),
      })
    )
  })

  it('raises a no-match item carrying the full evidence for later manual entry', async () => {
    const deps = fakeAdapter([
      { id: 'inv-1', invoiceNumber: 'INV-999', clientName: 'Nobody Related', balanceDue: 1000, sentAt: '2026-08-01' },
    ])
    const outcome = await proposePaymentMatch(
      {
        ...BASE,
        subject: 'Payment sent',
        body: 'Hi, we wired $750.00 to your account today, ref CONF-8842.',
        from: 'Sven <sven@newclient.example>',
      },
      deps
    )
    expect(outcome).toMatchObject({ staged: 'no_match' })
    expect(gatedExecute).not.toHaveBeenCalled()
    const call = observeAttentionItem.mock.calls[0][0]
    expect(call.subjectType).toBe('payment_signal')
    expect(call.nextAction).toContain('750.00')
    expect(call.nextAction).toContain('Sven')
    expect(call.nextAction).toContain('newclient.example')
    expect(call.nextAction).toContain('CONF-8842')
    expect(call.nextAction).toContain('thread-1')
  })
})
