import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BedrockWriteProvider,
  type BedrockInvoiceInsert,
  type BedrockPaymentInsert,
  type BedrockTimeEntryInsert,
} from './write-provider'
import type { BedrockConnection } from './types'

const connection: BedrockConnection = {
  workspaceId: 'ws-1',
  companyId: 'company-1',
  supabaseUrl: 'https://bedrock.invalid',
  serviceRoleKey: 'super-secret-key',
}

// Realistic ODS crew-day fixtures: 60-minute break, 07:00-16:00 shift,
// 8 regular hours, no overtime -- the measured defaults from the brief.
function crewDayRow(overrides: Partial<BedrockTimeEntryInsert> = {}): BedrockTimeEntryInsert {
  return {
    worker_id: 'worker-omar',
    project_id: 'project-blue-sky-great-room',
    date: '2026-09-02',
    start_time: '07:00:00',
    end_time: '16:00:00',
    break_duration_minutes: 60,
    regular_hours: 8,
    overtime_hours: 0,
    notes: 'Blue Sky Villa — Great Room Flooring',
    created_by: 'caye-agent',
    company_id: 'company-1',
    ...overrides,
  }
}

// Realistic ODS receivables fixtures pulled from the audit: the Sundancer
// final invoice, and the Christiansen 40% progress payment.
function invoiceRow(overrides: Partial<BedrockInvoiceInsert> = {}): BedrockInvoiceInsert {
  return {
    invoice_number: 'ODS-2026-0901-DAMIANOS-FINAL',
    client_name: 'Damianos — Sundancer',
    invoice_type: 'final',
    status: 'sent',
    issue_date: '2026-09-01',
    due_date: '2026-09-15',
    created_by: 'caye-agent',
    client_id: 'client-damianos',
    project_id: 'project-sundancer',
    estimate_id: null,
    subtotal: 2841.41,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 2841.41,
    notes: null,
    terms: null,
    sent_at: '2026-09-01T14:00:00Z',
    company_id: 'company-1',
    ...overrides,
  }
}

function paymentRow(overrides: Partial<BedrockPaymentInsert> = {}): BedrockPaymentInsert {
  return {
    invoice_id: 'invoice-christiansen-40pct',
    payment_date: '2026-09-02',
    amount: 10378.0,
    payment_method: 'wire',
    received_by: 'caye-agent',
    reference_number: 'WIRE-20260902-CHRISTIANSEN',
    notes: '40% progress payment',
    ...overrides,
  }
}

type TimeEntryOutcome = { data?: { id: string }; error?: { message: string } | null }
type SelectOutcome = { data?: { id: string } | null; error?: { message: string } | null }
type InvoiceLookupOutcome = { data?: { id: string } | null; error?: { message: string } | null }
type AuditLogOutcome = { error?: { message: string } | null }

/**
 * Fake Supabase client -- no module mocking, no network, per house
 * convention (lib/domain-adapters/bedrock/adapter.test.ts). Records every
 * row handed to `time_entries`, `invoices`, `payments`, and `audit_logs`
 * inserts, every `invoices` ownership lookup, and lets each test script
 * per-call outcomes.
 *
 * `invoiceLookupOutcome` defaults to "not found" (`{ data: null }`) rather
 * than "found" -- a payment test must opt in to a matching invoice
 * explicitly, so a forgotten mock fails loudly (as a denied write) instead
 * of silently succeeding.
 */
function fakeClient(
  options: {
    timeEntryOutcomes?: (row: Record<string, unknown>, index: number) => TimeEntryOutcome
    invoiceInsertOutcome?: (row: Record<string, unknown>) => SelectOutcome
    paymentInsertOutcome?: (row: Record<string, unknown>) => SelectOutcome
    invoiceLookupOutcome?: (filters: { id?: string; company_id?: string }) => InvoiceLookupOutcome
    auditLogOutcome?: (row: Record<string, unknown>) => AuditLogOutcome
  } = {},
) {
  const timeEntryCalls: Record<string, unknown>[] = []
  const invoiceInsertCalls: Record<string, unknown>[] = []
  const paymentInsertCalls: Record<string, unknown>[] = []
  const invoiceLookupCalls: { id?: string; company_id?: string }[] = []
  const auditLogCalls: Record<string, unknown>[] = []
  let timeEntrySeq = 0

  const client = {
    from(table: string) {
      if (table === 'time_entries') {
        return {
          insert(row: Record<string, unknown>) {
            timeEntryCalls.push(row)
            const index = timeEntrySeq++
            return {
              select() {
                return {
                  async single(): Promise<TimeEntryOutcome> {
                    if (options.timeEntryOutcomes) {
                      const outcome = options.timeEntryOutcomes(row, index)
                      return { data: outcome.data, error: outcome.error ?? null }
                    }
                    return { data: { id: `time-entry-${index}` }, error: null }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'invoices') {
        return {
          insert(row: Record<string, unknown>) {
            invoiceInsertCalls.push(row)
            return {
              select() {
                return {
                  async single(): Promise<SelectOutcome> {
                    if (options.invoiceInsertOutcome) {
                      const outcome = options.invoiceInsertOutcome(row)
                      return { data: outcome.data ?? null, error: outcome.error ?? null }
                    }
                    return { data: { id: 'invoice-new-1' }, error: null }
                  },
                }
              },
            }
          },
          select() {
            const filters: { id?: string; company_id?: string } = {}
            const builder = {
              eq(column: string, value: string) {
                if (column === 'id' || column === 'company_id') filters[column] = value
                return builder
              },
              async maybeSingle(): Promise<InvoiceLookupOutcome> {
                invoiceLookupCalls.push({ ...filters })
                if (options.invoiceLookupOutcome) {
                  const outcome = options.invoiceLookupOutcome({ ...filters })
                  return { data: outcome.data ?? null, error: outcome.error ?? null }
                }
                return { data: null, error: null }
              },
            }
            return builder
          },
        }
      }
      if (table === 'payments') {
        return {
          insert(row: Record<string, unknown>) {
            paymentInsertCalls.push(row)
            return {
              select() {
                return {
                  async single(): Promise<SelectOutcome> {
                    if (options.paymentInsertOutcome) {
                      const outcome = options.paymentInsertOutcome(row)
                      return { data: outcome.data ?? null, error: outcome.error ?? null }
                    }
                    return { data: { id: 'payment-new-1' }, error: null }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'audit_logs') {
        return {
          insert(row: Record<string, unknown>) {
            auditLogCalls.push(row)
            const outcome = options.auditLogOutcome ? options.auditLogOutcome(row) : { error: null }
            return Promise.resolve({ error: outcome.error ?? null })
          },
        }
      }
      throw new Error(`fakeClient: unexpected table "${table}"`)
    },
  } as unknown as SupabaseClient

  return { client, timeEntryCalls, invoiceInsertCalls, paymentInsertCalls, invoiceLookupCalls, auditLogCalls }
}

function makeProvider(fake: ReturnType<typeof fakeClient>) {
  return new BedrockWriteProvider(connection, () => fake.client)
}

describe('BedrockWriteProvider.insertTimeEntries', () => {
  it('forces the resolved company id onto every row, even when the caller passed a different one', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [
      crewDayRow({ worker_id: 'worker-omar', company_id: 'foreign-company-999' }),
      crewDayRow({ worker_id: 'worker-dwight', company_id: 'another-foreign-company' }),
    ])

    expect(result.insertedCount).toBe(2)
    expect(fake.timeEntryCalls).toHaveLength(2)
    for (const call of fake.timeEntryCalls) {
      expect(call.company_id).toBe('company-1')
    }
  })

  it('writes exactly one audit_logs row with the constrained source/scope/tier on success', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [crewDayRow()])

    expect(result.ok).toBe(true)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({
      company_id: 'company-1',
      source: 'api',
      scope: 'write',
      tier: 'confirm',
      status: 'ok',
      target_table: 'time_entries',
    })
    expect(result.auditLogWritten).toBe(true)
    expect(result.auditLogError).toBeNull()
  })

  it('still writes an audit row when the insert fails, with status error and a message', async () => {
    const fake = fakeClient({
      timeEntryOutcomes: () => ({ error: { message: 'duplicate key value violates unique constraint' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [crewDayRow()])

    expect(result.ok).toBe(false)
    expect(result.insertedCount).toBe(0)
    expect(result.failedRows).toHaveLength(1)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ status: 'error' })
    expect(fake.auditLogCalls[0].error_message).toContain('duplicate key value')
  })

  it('reports partial failure with precise counts and names the failed rows, never as success', async () => {
    const fake = fakeClient({
      timeEntryOutcomes: (_row, index) =>
        index === 1 ? { error: { message: 'worker_id violates foreign key constraint' } } : { data: { id: `time-entry-${index}` } },
    })
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [
      crewDayRow({ worker_id: 'worker-omar' }),
      crewDayRow({ worker_id: 'worker-unknown' }),
      crewDayRow({ worker_id: 'worker-dwight' }),
    ])

    expect(result.ok).toBe(false)
    expect(result.attemptedCount).toBe(3)
    expect(result.insertedCount).toBe(2)
    expect(result.failedRows).toHaveLength(1)
    expect(result.failedRows[0]).toMatchObject({ index: 1, error: expect.stringContaining('foreign key') })
    expect((result.failedRows[0].row as BedrockTimeEntryInsert).worker_id).toBe('worker-unknown')

    expect(fake.auditLogCalls[0]).toMatchObject({ status: 'error' })
    const auditResult = fake.auditLogCalls[0].result as { insertedCount: number; failedCount: number }
    expect(auditResult.insertedCount).toBe(2)
    expect(auditResult.failedCount).toBe(1)
  })

  it('surfaces an audit-log write failure on the result instead of swallowing it', async () => {
    const fake = fakeClient({
      auditLogOutcome: () => ({ error: { message: 'audit_logs insert timed out' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [crewDayRow()])

    // The time entry itself landed...
    expect(result.insertedCount).toBe(1)
    // ...but the overall result must not read as a clean success, because
    // the write is now invisible to ODS's own audit trail.
    expect(result.ok).toBe(false)
    expect(result.auditLogWritten).toBe(false)
    expect(result.auditLogError).toBe('audit_logs insert timed out')
  })

  it('treats an empty rows array as a no-op that writes no audit row', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertTimeEntries('company-1', [])

    expect(result).toEqual({
      ok: true,
      attemptedCount: 0,
      insertedCount: 0,
      insertedIds: [],
      failedRows: [],
      auditLogWritten: false,
      auditLogError: null,
    })
    expect(fake.timeEntryCalls).toHaveLength(0)
    expect(fake.auditLogCalls).toHaveLength(0)
  })

  it('cannot set approved_by or approved_at through this path', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const rowWithApproval = {
      ...crewDayRow(),
      approved_by: 'sneaky-approver',
      approved_at: '2026-09-02T00:00:00Z',
    } as unknown as BedrockTimeEntryInsert

    await provider.insertTimeEntries('company-1', [rowWithApproval])

    expect(fake.timeEntryCalls).toHaveLength(1)
    expect(fake.timeEntryCalls[0]).not.toHaveProperty('approved_by')
    expect(fake.timeEntryCalls[0]).not.toHaveProperty('approved_at')
  })
})

describe('BedrockWriteProvider.insertInvoice', () => {
  it('forces the resolved company id onto the row, even when the caller passed a different one', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertInvoice('company-1', invoiceRow({ company_id: 'foreign-company-999' }))

    expect(result.ok).toBe(true)
    expect(fake.invoiceInsertCalls).toHaveLength(1)
    expect(fake.invoiceInsertCalls[0].company_id).toBe('company-1')
    expect(fake.invoiceInsertCalls[0].invoice_number).toBe('ODS-2026-0901-DAMIANOS-FINAL')
  })

  it('writes exactly one audit_logs row with the constrained values on success', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const result = await provider.insertInvoice('company-1', invoiceRow())

    expect(result.ok).toBe(true)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({
      company_id: 'company-1',
      tool_name: 'insertInvoice',
      source: 'api',
      scope: 'write',
      tier: 'confirm',
      status: 'ok',
      target_table: 'invoices',
    })
  })

  it('still writes an audit row when the insert fails, with status error', async () => {
    const fake = fakeClient({
      invoiceInsertOutcome: () => ({ error: { message: 'duplicate key value violates unique constraint "invoices_invoice_number_key"' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertInvoice('company-1', invoiceRow())

    expect(result.ok).toBe(false)
    expect(result.insertedCount).toBe(0)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ status: 'error', target_table: 'invoices' })
    expect(fake.auditLogCalls[0].error_message).toContain('invoices_invoice_number_key')
  })

  it('cannot set approved_by or approved_at through this path', async () => {
    const fake = fakeClient()
    const provider = makeProvider(fake)

    const rowWithApproval = {
      ...invoiceRow(),
      approved_by: 'sneaky-approver',
      approved_at: '2026-09-02T00:00:00Z',
    } as unknown as BedrockInvoiceInsert

    await provider.insertInvoice('company-1', rowWithApproval)

    expect(fake.invoiceInsertCalls).toHaveLength(1)
    expect(fake.invoiceInsertCalls[0]).not.toHaveProperty('approved_by')
    expect(fake.invoiceInsertCalls[0]).not.toHaveProperty('approved_at')
  })
})

describe('BedrockWriteProvider.insertPayment', () => {
  it('refuses a payment against another company\'s invoice: no payment row written, audited as denied', async () => {
    const fake = fakeClient({
      // The invoice exists, but not for this company -- the id+company_id
      // scoped lookup finds nothing.
      invoiceLookupOutcome: () => ({ data: null }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertPayment('company-1', paymentRow())

    expect(result.ok).toBe(false)
    expect(result.insertedCount).toBe(0)
    expect(fake.paymentInsertCalls).toHaveLength(0)
    expect(fake.invoiceLookupCalls).toEqual([{ id: 'invoice-christiansen-40pct', company_id: 'company-1' }])
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({
      company_id: 'company-1',
      tool_name: 'insertPayment',
      source: 'api',
      scope: 'write',
      tier: 'confirm',
      status: 'denied',
      target_table: 'payments',
    })
  })

  it('refuses a payment against a non-existent invoice cleanly, rather than throwing', async () => {
    const fake = fakeClient({
      invoiceLookupOutcome: () => ({ error: { message: 'invoice not found' } }),
    })
    const provider = makeProvider(fake)

    await expect(provider.insertPayment('company-1', paymentRow())).resolves.toMatchObject({
      ok: false,
      insertedCount: 0,
    })
    expect(fake.paymentInsertCalls).toHaveLength(0)
    expect(fake.auditLogCalls[0]).toMatchObject({ status: 'denied', target_table: 'payments' })
  })

  it('writes exactly one audit row with the constrained values on a successful payment', async () => {
    const fake = fakeClient({
      invoiceLookupOutcome: filters => ({ data: { id: filters.id ?? 'invoice-christiansen-40pct' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertPayment('company-1', paymentRow())

    expect(result.ok).toBe(true)
    expect(fake.paymentInsertCalls).toHaveLength(1)
    expect(fake.paymentInsertCalls[0]).toMatchObject({
      invoice_id: 'invoice-christiansen-40pct',
      amount: 10378.0,
      payment_method: 'wire',
      received_by: 'caye-agent',
    })
    expect(fake.paymentInsertCalls[0]).not.toHaveProperty('company_id')

    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({
      company_id: 'company-1',
      tool_name: 'insertPayment',
      source: 'api',
      scope: 'write',
      tier: 'confirm',
      status: 'ok',
      target_table: 'payments',
    })
  })

  it('still writes an audit row when the insert fails, with status error', async () => {
    const fake = fakeClient({
      invoiceLookupOutcome: filters => ({ data: { id: filters.id ?? 'invoice-christiansen-40pct' } }),
      paymentInsertOutcome: () => ({ error: { message: 'amount must be positive' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertPayment('company-1', paymentRow())

    expect(result.ok).toBe(false)
    expect(result.insertedCount).toBe(0)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ status: 'error', target_table: 'payments' })
    expect(fake.auditLogCalls[0].error_message).toContain('amount must be positive')
  })

  it('surfaces an audit-log write failure on the result instead of swallowing it', async () => {
    const fake = fakeClient({
      invoiceLookupOutcome: filters => ({ data: { id: filters.id ?? 'invoice-christiansen-40pct' } }),
      auditLogOutcome: () => ({ error: { message: 'audit_logs insert timed out' } }),
    })
    const provider = makeProvider(fake)

    const result = await provider.insertPayment('company-1', paymentRow())

    expect(result.insertedCount).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.auditLogWritten).toBe(false)
    expect(result.auditLogError).toBe('audit_logs insert timed out')
  })

  it('cannot set company_id, approved_by, or approved_at through this path', async () => {
    const fake = fakeClient({
      invoiceLookupOutcome: filters => ({ data: { id: filters.id ?? 'invoice-christiansen-40pct' } }),
    })
    const provider = makeProvider(fake)

    const rowWithExtras = {
      ...paymentRow(),
      company_id: 'company-1',
      approved_by: 'sneaky-approver',
      approved_at: '2026-09-02T00:00:00Z',
    } as unknown as BedrockPaymentInsert

    await provider.insertPayment('company-1', rowWithExtras)

    expect(fake.paymentInsertCalls).toHaveLength(1)
    expect(fake.paymentInsertCalls[0]).not.toHaveProperty('company_id')
    expect(fake.paymentInsertCalls[0]).not.toHaveProperty('approved_by')
    expect(fake.paymentInsertCalls[0]).not.toHaveProperty('approved_at')
  })
})

describe('BedrockWriteProvider public surface', () => {
  it('exposes no update or delete method -- insert-only, by design', () => {
    const methodNames = Object.getOwnPropertyNames(BedrockWriteProvider.prototype)

    for (const name of methodNames) {
      expect(name.toLowerCase()).not.toMatch(/update|delete|upsert/)
    }

    // And the three insert capabilities this class is scoped to are present.
    expect(methodNames).toEqual(expect.arrayContaining(['insertTimeEntries', 'insertInvoice', 'insertPayment']))
  })
})
