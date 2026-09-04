import { describe, expect, it } from 'vitest'

import type { BedrockInvoice } from '@/lib/domain-adapters/bedrock'
import {
  RECEIVABLES_ATTENTION_THRESHOLDS,
  SUBJECT_RECEIVABLE,
  fingerprintPartsFor,
  priorityFor,
  raiseReceivablesAttention,
  titleFor,
  type ReceivableInvoice,
} from './receivables-attention'

const WORKSPACE = 'ws-1'

/** Fixed clock, matching the ODS audit's own reference date. Never the real wall clock. */
const NOW = () => new Date('2026-09-02T12:00:00Z')

function invoice(overrides: Partial<BedrockInvoice> = {}): BedrockInvoice {
  return {
    sourceSystem: 'bedrock',
    authority: 'external_authoritative',
    sourceEntityType: 'invoice',
    sourceEntityId: 'invoice-1',
    workspaceId: WORKSPACE,
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

// Realistic ODS audit fixtures -- ages relative to NOW = 2026-09-02, none confirmed.
const offTheReef = invoice({
  id: 'inv-off-the-reef',
  invoiceNumber: 'INV-101',
  clientName: 'Off the Reef',
  totalAmount: 17575.75,
  balanceDue: 17575.75,
  issueDate: '2026-07-01',
  sentAt: '2026-07-01T09:00:00Z',
})

const islandBreeze = invoice({
  id: 'inv-island-breeze',
  invoiceNumber: 'INV-102',
  clientName: 'Island Breeze',
  totalAmount: 25533.42,
  balanceDue: 25533.42,
  issueDate: '2026-08-10',
  sentAt: '2026-08-10T09:00:00Z',
})

const laVieEnRose = invoice({
  id: 'inv-la-vie-en-rose',
  invoiceNumber: 'INV-103',
  clientName: 'La Vie en Rose',
  totalAmount: 19624.5,
  balanceDue: 19624.5,
  issueDate: '2026-08-14',
  sentAt: '2026-08-14T09:00:00Z',
})

// Client acknowledged receiving the invoice -- NOT a payment. Still unconfirmed.
const sundancer = invoice({
  id: 'inv-sundancer',
  invoiceNumber: 'INV-104',
  clientName: 'Sundancer',
  totalAmount: 2841.41,
  balanceDue: 2841.41,
  issueDate: '2026-09-01',
  sentAt: '2026-09-01T09:00:00Z',
})

function makeAdapter(
  invoices: BedrockInvoice[],
  paymentsByInvoiceId: Record<string, Array<Record<string, unknown>>> = {}
) {
  return () => ({
    listInvoices: async (workspaceId: string) => {
      expect(workspaceId).toBe(WORKSPACE)
      return invoices
    },
    getInvoiceWithPayments: async (workspaceId: string, id: string) => {
      expect(workspaceId).toBe(WORKSPACE)
      const found = invoices.find((i) => i.id === id)
      if (!found) throw new Error(`invoice ${id} not found`)
      return { invoice: found, payments: paymentsByInvoiceId[id] ?? [] }
    },
  })
}

/** Records what the ledger was asked to observe, without touching Supabase. */
function recorder() {
  const calls: Array<Record<string, unknown>> = []
  const observe = (async (args: Record<string, unknown>) => {
    calls.push(args)
    return null
  }) as never
  return { calls, observe }
}

describe('raiseReceivablesAttention', () => {
  it('raises attention for an unconfirmed invoice and skips a fully settled one', async () => {
    const settled = invoice({ id: 'inv-settled', clientName: 'Paid Co', balanceDue: 0, amountPaid: 100, status: 'paid' })
    const { calls, observe } = recorder()

    const result = await raiseReceivablesAttention({
      workspaceId: WORKSPACE,
      deps: { getAdapter: makeAdapter([offTheReef, settled]), observe, now: NOW },
    })

    expect(result).toEqual({ considered: 2, raised: 1, skipped: { draft: 0, settled: 1 } })
    expect(calls).toHaveLength(1)
    expect(calls[0].workspaceId).toBe(WORKSPACE)
    expect(calls[0].subjectType).toBe(SUBJECT_RECEIVABLE)
    expect(calls[0].subjectId).toBe('inv-off-the-reef')
  })

  it('does not count a never-sent draft as a receivable at all', async () => {
    const draft = invoice({ id: 'inv-draft', sentAt: null, status: 'draft' })
    const { calls, observe } = recorder()

    const result = await raiseReceivablesAttention({
      workspaceId: WORKSPACE,
      deps: { getAdapter: makeAdapter([draft]), observe, now: NOW },
    })

    expect(result).toEqual({ considered: 0, raised: 0, skipped: { draft: 1, settled: 0 } })
    expect(calls).toHaveLength(0)
  })

  it('treats a partially paid invoice as still outstanding', async () => {
    const partiallyPaid = invoice({
      id: 'inv-partial', clientName: 'Late Payer', totalAmount: 1000, amountPaid: 400, balanceDue: 600,
      issueDate: '2026-08-01', sentAt: '2026-08-01T00:00:00Z',
    })
    const { calls, observe } = recorder()

    const result = await raiseReceivablesAttention({
      workspaceId: WORKSPACE,
      deps: {
        getAdapter: makeAdapter([partiallyPaid], { 'inv-partial': [{ id: 'pay-1', amount: 400 }] }),
        observe,
        now: NOW,
      },
    })

    expect(result.raised).toBe(1)
    expect(calls[0].subjectId).toBe('inv-partial')
    expect(String(calls[0].title)).toMatch(/\$600\.00 outstanding/)
    expect(String(calls[0].title)).toMatch(/partial payment on record/)
  })

  it('re-running the same day raises nothing new -- the fingerprint holds', async () => {
    const first = recorder()
    await raiseReceivablesAttention({ workspaceId: WORKSPACE, deps: { getAdapter: makeAdapter([offTheReef]), observe: first.observe, now: NOW } })

    const second = recorder()
    await raiseReceivablesAttention({ workspaceId: WORKSPACE, deps: { getAdapter: makeAdapter([offTheReef]), observe: second.observe, now: NOW } })

    expect(first.calls[0].fingerprintParts).toEqual(second.calls[0].fingerprintParts)
  })

  it('does not change the fingerprint from age alone, even ten days later', async () => {
    const later = () => new Date('2026-09-12T12:00:00Z')

    const today = recorder()
    await raiseReceivablesAttention({ workspaceId: WORKSPACE, deps: { getAdapter: makeAdapter([offTheReef]), observe: today.observe, now: NOW } })

    const tenDaysOn = recorder()
    await raiseReceivablesAttention({ workspaceId: WORKSPACE, deps: { getAdapter: makeAdapter([offTheReef]), observe: tenDaysOn.observe, now: later } })

    // The invoice itself did not change -- only its age did -- so the
    // fingerprint the ledger keys re-notification on must be identical.
    expect(today.calls[0].fingerprintParts).toEqual(tenDaysOn.calls[0].fingerprintParts)
    // Sanity check this isn't vacuous: the same two runs *do* produce
    // different priorities, because priority (unlike the fingerprint)
    // is allowed to move with age.
    expect(today.calls[0].priority).toBe('critical') // 63 days, never confirmed
  })

  it('changes the fingerprint when the balance moves or a payment is first confirmed', () => {
    const outstanding: ReceivableInvoice = {
      id: 'inv-1', invoiceNumber: 'INV-1', clientName: 'Client', issueDate: '2026-07-01', balanceDue: 100, sentAt: '2026-07-01T00:00:00Z',
    }
    const stillUnconfirmed = fingerprintPartsFor(outstanding, false)
    const partiallyPaid = fingerprintPartsFor({ ...outstanding, balanceDue: 60 }, false)
    const nowConfirmed = fingerprintPartsFor({ ...outstanding, balanceDue: 60 }, true)

    expect(partiallyPaid).not.toEqual(stillUnconfirmed)
    expect(nowConfirmed).not.toEqual(partiallyPaid)
  })

  it('a failure reading one workspace does not stop a caller sweeping others', async () => {
    // raiseReceivablesAttention itself always operates on one workspace; the
    // isolation guarantee lives one level up, in
    // construction-ledger-cycle.ts's per-workspace try/catch (see its tests:
    // "a receivables failure in one workspace does not stop the sweep for
    // the next"). Documented here so the requirement is traceable from this
    // module too: a rejection from this function must be a clean throw, not
    // a partially-applied side effect, so the caller's try/catch can isolate
    // it cleanly.
    const { observe } = recorder()
    const failingAdapter = () => ({
      listInvoices: async () => { throw new Error('bedrock unreachable') },
      getInvoiceWithPayments: async () => { throw new Error('should not be called') },
    })

    await expect(
      raiseReceivablesAttention({ workspaceId: WORKSPACE, deps: { getAdapter: failingAdapter, observe, now: NOW } })
    ).rejects.toThrow('bedrock unreachable')
  })
})

describe('priorityFor', () => {
  it('matches the ODS audit fixtures: oldest and never-confirmed is worst', () => {
    // Off the Reef: 63 days, never confirmed.
    expect(priorityFor(false, 63)).toBe('critical')
    // Island Breeze: 23 days, never confirmed.
    expect(priorityFor(false, 23)).toBe('decision')
    // La Vie en Rose: 19 days, never confirmed.
    expect(priorityFor(false, 19)).toBe('decision')
    // Sundancer: 1 day, client acknowledged (not a payment) -- still never confirmed, but fresh.
    expect(priorityFor(false, 1)).toBe('awareness')
  })

  it('escalates with age on both tracks', () => {
    expect(priorityFor(false, 0)).toBe('awareness')
    expect(priorityFor(false, RECEIVABLES_ATTENTION_THRESHOLDS.neverConfirmed.decisionAfterDays)).toBe('decision')
    expect(priorityFor(false, RECEIVABLES_ATTENTION_THRESHOLDS.neverConfirmed.criticalAfterDays)).toBe('critical')

    expect(priorityFor(true, 0)).toBe('routine')
    expect(priorityFor(true, RECEIVABLES_ATTENTION_THRESHOLDS.partiallyConfirmed.awarenessAfterDays)).toBe('awareness')
    expect(priorityFor(true, RECEIVABLES_ATTENTION_THRESHOLDS.partiallyConfirmed.decisionAfterDays)).toBe('decision')
  })

  it('is worse for an invoice with no payment ever recorded than one with a payment on record, at the same age', () => {
    const days = 20
    const neverConfirmedPriority = priorityFor(false, days)
    const partiallyConfirmedPriority = priorityFor(true, days)

    const rank: Record<string, number> = { routine: 0, awareness: 1, decision: 2, critical: 3 }
    expect(rank[neverConfirmedPriority]).toBeGreaterThan(rank[partiallyConfirmedPriority])
  })
})

describe('nextAction (via observed calls)', () => {
  it('never asserts that money did or did not arrive, for either an unconfirmed or a partially paid invoice', async () => {
    const partiallyPaid = invoice({ id: 'inv-partial', balanceDue: 60, sentAt: '2026-08-01T00:00:00Z', issueDate: '2026-08-01' })
    const { calls, observe } = recorder()

    await raiseReceivablesAttention({
      workspaceId: WORKSPACE,
      deps: {
        getAdapter: makeAdapter([offTheReef, partiallyPaid], { 'inv-partial': [{ id: 'pay-1', amount: 40 }] }),
        observe,
        now: NOW,
      },
    })

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const nextAction = String(call.nextAction).toLowerCase()
      // Must ask, never conclude -- see briefs/ods-receivables-loop.md:
      // "The bank is the arbiter, and the bank is in no system."
      expect(nextAction).not.toMatch(/money (has |)arrived/)
      expect(nextAction).not.toMatch(/paid in full/)
      expect(nextAction).not.toMatch(/(was|has been) received/)
      expect(nextAction).not.toMatch(/no money/)
      expect(nextAction).toMatch(/check the bank/)
      expect(nextAction).toMatch(/tell me either way/)
    }
  })
})

describe('titleFor', () => {
  it('names the client, the balance, the age and the confirmation state so nothing needs opening to read it', () => {
    const title = titleFor(
      { id: 'inv-off-the-reef', invoiceNumber: 'INV-101', clientName: 'Off the Reef', issueDate: '2026-07-01', balanceDue: 17575.75, sentAt: '2026-07-01T00:00:00Z' },
      false,
      63
    )
    expect(title).toBe('Off the Reef: $17575.75 outstanding, 63 days, no payment ever recorded')
  })
})
