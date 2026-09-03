import { describe, it, expect } from 'vitest'
import { makeGetReceivables } from './get-receivables'
import { BedrockConnectionMissingError, type BedrockInvoice } from '@/lib/domain-adapters/bedrock'
import type { ToolContext } from '../types'

const ctx: ToolContext = {
  workspaceId: 'ws-1',
  callerRole: 'owner',
  requestId: 'req-1',
}

/** Fixed clock so ageing assertions never depend on the real wall-clock date. */
const NOW = () => new Date('2026-09-02T12:00:00Z')

function invoice(overrides: Partial<BedrockInvoice> = {}): BedrockInvoice {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'invoice',
    sourceEntityId: 'invoice-1',
    workspaceId: 'ws-1',
    companyId: 'company-1',
    id: 'invoice-1',
    invoiceNumber: 'INV-1',
    clientName: 'Client',
    projectId: 'project-1',
    status: 'sent',
    issueDate: '2026-07-01',
    dueDate: '2026-07-31',
    totalAmount: 100,
    amountPaid: 0,
    balanceDue: 100,
    sentAt: '2026-07-01T09:00:00Z',
    paidAt: null,
    ...overrides,
  }
}

// Realistic ODS audit fixtures (all sent, none confirmed, ages relative to NOW = 2026-09-02).
const offTheReef = invoice({
  id: 'inv-off-the-reef',
  invoiceNumber: 'INV-101',
  clientName: 'Off the Reef',
  totalAmount: 17575.75,
  amountPaid: 0,
  balanceDue: 17575.75,
  issueDate: '2026-07-01',
  dueDate: '2026-07-31',
  sentAt: '2026-07-01T09:00:00Z',
})

const islandBreeze = invoice({
  id: 'inv-island-breeze',
  invoiceNumber: 'INV-102',
  clientName: 'Island Breeze',
  totalAmount: 25533.42,
  amountPaid: 0,
  balanceDue: 25533.42,
  issueDate: '2026-08-10',
  dueDate: '2026-08-24',
  sentAt: '2026-08-10T09:00:00Z',
})

const laVieEnRose = invoice({
  id: 'inv-la-vie-en-rose',
  invoiceNumber: 'INV-103',
  clientName: 'La Vie en Rose',
  totalAmount: 19624.5,
  amountPaid: 0,
  balanceDue: 19624.5,
  issueDate: '2026-08-14',
  dueDate: '2026-09-13',
  sentAt: '2026-08-14T09:00:00Z',
})

const sundancer = invoice({
  id: 'inv-sundancer',
  invoiceNumber: 'INV-104',
  clientName: 'Sundancer',
  totalAmount: 2841.41,
  amountPaid: 0,
  balanceDue: 2841.41,
  issueDate: '2026-09-01',
  dueDate: '2026-10-01',
  sentAt: '2026-09-01T09:00:00Z',
})

function makeAdapter(
  invoices: BedrockInvoice[],
  paymentsByInvoiceId: Record<string, Array<Record<string, unknown>>> = {}
) {
  return () => ({
    listInvoices: async (workspaceId: string) => {
      expect(workspaceId).toBe('ws-1')
      return invoices
    },
    getInvoiceWithPayments: async (workspaceId: string, id: string) => {
      expect(workspaceId).toBe('ws-1')
      const found = invoices.find((i) => i.id === id)
      if (!found) throw new Error(`invoice ${id} not found`)
      return { invoice: found, payments: paymentsByInvoiceId[id] ?? [] }
    },
  })
}

describe('getReceivables', () => {
  // The empty ledger is the state ODS is ACTUALLY in: zero invoice rows
  // against 25 projects, while roughly $94,178 sits outstanding in email and
  // spreadsheets. So the empty case is not an edge case here -- it is the
  // production case, and the one where a confident wrong answer does real
  // harm. These pin that emptiness is reported as its own fact and never as
  // a zero balance.
  describe('an empty register is never reported as nothing owed', () => {
    it('says nothing has been RECORDED, not that nothing is outstanding', async () => {
      const tool = makeGetReceivables(makeAdapter([]), NOW)

      const result = await tool.execute({}, ctx)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')

      expect(result.data.nothing_recorded).toBe(true)
      expect(result.data.total_invoices).toBe(0)
      expect(result.data.total_outstanding_balance).toBe(0)

      // The zero is present, but it never travels without the sentence that
      // says what it means -- that is the whole point.
      const note = String(result.data.nothing_recorded_note)
      expect(note).toMatch(/not.*mean.*no money is owed|does NOT mean/i)
      expect(note).toMatch(/record/i)
    })

    it('distinguishes an empty JOB from an empty register', async () => {
      const tool = makeGetReceivables(makeAdapter([]), NOW)

      const scoped = await tool.execute({ project_id: 'project-1' }, ctx)
      const whole = await tool.execute({}, ctx)
      if (!scoped.ok || !whole.ok) throw new Error('unreachable')

      // Same zero, two different facts: one job having no invoice is ordinary;
      // the register having none at all is the thing worth saying out loud.
      expect(scoped.data.nothing_recorded_note).not.toBe(whole.data.nothing_recorded_note)
      expect(String(scoped.data.nothing_recorded_note)).toMatch(/this job/i)
    })

    it('stays silent about emptiness the moment there is anything to report', async () => {
      const tool = makeGetReceivables(makeAdapter([offTheReef]), NOW)

      const result = await tool.execute({}, ctx)
      if (!result.ok) throw new Error('unreachable')

      expect(result.data.nothing_recorded).toBe(false)
      expect(result.data.nothing_recorded_note).toBeNull()
    })
  })

  it('ages every invoice from issue_date/due_date at the injected clock, never a stored figure', async () => {
    const tool = makeGetReceivables(makeAdapter([offTheReef, islandBreeze, laVieEnRose, sundancer]), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any

    const byId = Object.fromEntries(data.invoices.map((i: any) => [i.id, i]))
    expect(byId['inv-off-the-reef'].days_outstanding).toBe(63)
    expect(byId['inv-island-breeze'].days_outstanding).toBe(23)
    expect(byId['inv-la-vie-en-rose'].days_outstanding).toBe(19)
    expect(byId['inv-sundancer'].days_outstanding).toBe(1)
  })

  it('classifies a mix of paid / partially paid / unconfirmed / overdue invoices correctly', async () => {
    const paidInFull = invoice({
      id: 'inv-paid', clientName: 'Paid Co', balanceDue: 0, amountPaid: 100, status: 'paid', paidAt: '2026-07-15T00:00:00Z',
    })
    const partiallyPaidOverdue = invoice({
      id: 'inv-partial-overdue', clientName: 'Late Payer', totalAmount: 1000, amountPaid: 400, balanceDue: 600,
      issueDate: '2026-06-01', dueDate: '2026-06-30', sentAt: '2026-06-01T00:00:00Z', status: 'partial',
    })
    const unconfirmedNotYetDue = invoice({
      id: 'inv-not-due', clientName: 'Fresh Invoice', issueDate: '2026-08-25', dueDate: '2026-09-25', sentAt: '2026-08-25T00:00:00Z',
    })
    const unconfirmedOverdue = offTheReef

    const tool = makeGetReceivables(
      makeAdapter(
        [paidInFull, partiallyPaidOverdue, unconfirmedNotYetDue, unconfirmedOverdue],
        { 'inv-partial-overdue': [{ id: 'pay-1', amount: 400, payment_date: '2026-06-20', received_by: 'profile-1' }] }
      ),
      NOW
    )

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any

    // The fully paid invoice has no balance and is not a receivable at all.
    expect(data.invoices.find((i: any) => i.id === 'inv-paid')).toBeUndefined()
    expect(data.total_invoices).toBe(3)

    const partial = data.invoices.find((i: any) => i.id === 'inv-partial-overdue')
    expect(partial.overdue).toBe(true)
    expect(partial.unconfirmed).toBe(false)
    expect(partial.has_payment_recorded).toBe(true)
    expect(partial.balance_due).toBe(600)

    const notDue = data.invoices.find((i: any) => i.id === 'inv-not-due')
    expect(notDue.overdue).toBe(false)
    expect(notDue.unconfirmed).toBe(true)

    const overdueUnconfirmed = data.invoices.find((i: any) => i.id === 'inv-off-the-reef')
    expect(overdueUnconfirmed.overdue).toBe(true)
    expect(overdueUnconfirmed.unconfirmed).toBe(true)

    expect(data.unconfirmed_count).toBe(2)
    expect(data.overdue_count).toBe(2)
  })

  it('never marks an invoice unconfirmed once any payment has been recorded, even if it is still overdue', async () => {
    const overdueWithPayment = invoice({
      id: 'inv-overdue-paid-some', issueDate: '2026-06-01', dueDate: '2026-06-30', sentAt: '2026-06-01T00:00:00Z',
      totalAmount: 500, amountPaid: 100, balanceDue: 400,
    })
    const tool = makeGetReceivables(
      makeAdapter([overdueWithPayment], { 'inv-overdue-paid-some': [{ id: 'pay-1', amount: 100 }] }),
      NOW
    )

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const row = (result.data as any).invoices[0]
    expect(row.overdue).toBe(true)
    expect(row.unconfirmed).toBe(false)
    expect(row.has_payment_recorded).toBe(true)
  })

  it('excludes drafts that have never been sent', async () => {
    const draft = invoice({ id: 'inv-draft', sentAt: null, status: 'draft' })
    const tool = makeGetReceivables(makeAdapter([draft]), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect((result.data as any).invoices).toHaveLength(0)
  })

  it('sorts oldest-unconfirmed first', async () => {
    const tool = makeGetReceivables(
      makeAdapter([sundancer, offTheReef, laVieEnRose, islandBreeze]),
      NOW
    )

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const ids = (result.data as any).invoices.map((i: any) => i.id)
    expect(ids).toEqual(['inv-off-the-reef', 'inv-island-breeze', 'inv-la-vie-en-rose', 'inv-sundancer'])
  })

  it('always states the bank is not connected, in the data itself', async () => {
    const tool = makeGetReceivables(makeAdapter([offTheReef]), NOW)
    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const data = result.data as any
    expect(data.bank_connected).toBe(false)
    expect(data.bank_note).toMatch(/no bank/i)
  })

  it('returns a clean error, not a throw, when the workspace has no TropiTrack connection', async () => {
    const tool = makeGetReceivables(() => ({
      listInvoices: async () => {
        throw new BedrockConnectionMissingError('ws-1')
      },
      getInvoiceWithPayments: async () => {
        throw new Error('should not be called')
      },
    }), NOW)

    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe('FAILED_PERMANENT')
    expect(result.error).toMatch(/no TropiTrack/i)
  })

  // Cross-tenant payment leakage is prevented one layer down: provider.ts's
  // listInvoicePayments validates the invoice belongs to the company before
  // ever querying `payments` (payments has no company_id of its own), and
  // adapter.ts's getInvoiceWithPayments only resolves an invoice that is
  // already in the company-scoped listInvoices result. Both are covered by
  // lib/domain-adapters/bedrock/tenant-isolation.smoke.test.ts. This tool
  // only ever asks getInvoiceWithPayments about ids it just got from
  // listInvoices for the caller's own workspace, so there is no path here
  // through which a foreign invoice id could be supplied.
  it('only ever asks for payments on invoice ids from this workspace\'s own listInvoices result', async () => {
    const seen: string[] = []
    const tool = makeGetReceivables(() => ({
      listInvoices: async () => [offTheReef],
      getInvoiceWithPayments: async (_workspaceId: string, id: string) => {
        seen.push(id)
        return { invoice: offTheReef, payments: [] }
      },
    }), NOW)

    await tool.execute({}, ctx)
    expect(seen).toEqual(['inv-off-the-reef'])
  })
})
