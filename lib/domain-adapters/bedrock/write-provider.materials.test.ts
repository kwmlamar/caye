import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BedrockWriteProvider, type BedrockMaterialInsert, type BedrockReceiptLineItemInsert } from './write-provider'
import type { BedrockConnection } from './types'

const connection: BedrockConnection = {
  workspaceId: 'ws-1',
  companyId: 'company-1',
  supabaseUrl: 'https://bedrock.invalid',
  serviceRoleKey: 'super-secret-key',
}

function lineItemRow(overrides: Partial<BedrockReceiptLineItemInsert> = {}): BedrockReceiptLineItemInsert {
  return {
    receipt_id: 'receipt-1',
    material_id: null,
    receipt_name: 'TIN TABS',
    qty: 10,
    unit: 'EA',
    unit_cost: 4.75,
    total_cost: 47.5,
    match_confidence: 'none',
    ...overrides,
  }
}

// insertReceiptLineItems takes {row, matchReason} entries, not bare rows --
// matchReason rides into audit_logs only. This helper mirrors log-receipt.ts's
// own call shape.
function entry(overrides: Partial<BedrockReceiptLineItemInsert> = {}, matchReason: string | null = null) {
  return { row: lineItemRow(overrides), matchReason }
}

// Matches the live convention: id = R<epoch-ms>_<index>, division_name is a
// literal constant. See log-receipt.ts's header comment for where this was
// verified.
function materialRow(overrides: Partial<BedrockMaterialInsert> = {}): BedrockMaterialInsert {
  return {
    id: 'R1783613593116_0',
    division_code: '05',
    division_name: 'From Receipt',
    category: 'Metal Fasteners',
    name: 'TIN TABS',
    unit: 'EA',
    unit_cost: 4.75,
    supplier: 'Buywise Hardware',
    notes: 'Added from receipt 2026-09-04',
    ...overrides,
  }
}

function fakeClient(
  options: {
    lineItemInsertErrors?: Record<number, string>
    materialInsertError?: string
    /** Receipt ids that exist and belong to 'company-1'. Defaults to just 'receipt-1', the id every lineItemRow() default uses. */
    ownedReceiptIds?: string[]
  } = {}
) {
  const ownedReceiptIds = options.ownedReceiptIds ?? ['receipt-1']
  const lineItemInsertCalls: Record<string, unknown>[] = []
  const materialInsertCalls: Record<string, unknown>[] = []
  const auditLogCalls: Record<string, unknown>[] = []
  const receiptLookupCalls: string[] = []

  const client = {
    from(table: string) {
      if (table === 'receipt_line_items') {
        return {
          insert(row: Record<string, unknown>) {
            const index = lineItemInsertCalls.length
            lineItemInsertCalls.push(row)
            return {
              select() {
                return {
                  async single() {
                    const err = options.lineItemInsertErrors?.[index]
                    return err ? { data: null, error: { message: err } } : { data: { id: `line-${index}` }, error: null }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'materials') {
        return {
          insert(row: Record<string, unknown>) {
            materialInsertCalls.push(row)
            return {
              select() {
                return {
                  async single() {
                    return options.materialInsertError
                      ? { data: null, error: { message: options.materialInsertError } }
                      : { data: { id: row.id }, error: null }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'receipts') {
        return {
          select() {
            return {
              eq(_col: string, receiptId: string) {
                receiptLookupCalls.push(receiptId)
                return {
                  eq() {
                    return {
                      async maybeSingle() {
                        return ownedReceiptIds.includes(receiptId)
                          ? { data: { id: receiptId }, error: null }
                          : { data: null, error: null }
                      },
                    }
                  },
                }
              },
            }
          },
        }
      }
      if (table === 'audit_logs') {
        return {
          async insert(row: Record<string, unknown>) {
            auditLogCalls.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`fakeClient: unexpected table "${table}"`)
    },
  } as unknown as SupabaseClient

  return { client, lineItemInsertCalls, materialInsertCalls, auditLogCalls, receiptLookupCalls }
}

function makeProvider(fake: ReturnType<typeof fakeClient>) {
  return new BedrockWriteProvider(connection, () => fake.client)
}

describe('BedrockWriteProvider.insertReceiptLineItems', () => {
  it('is a no-op for an empty array — no insert, no audit row', async () => {
    const fake = fakeClient()
    const result = await makeProvider(fake).insertReceiptLineItems('company-1', [])

    expect(result).toMatchObject({ ok: true, attemptedCount: 0, insertedCount: 0 })
    expect(fake.lineItemInsertCalls).toHaveLength(0)
    expect(fake.auditLogCalls).toHaveLength(0)
  })

  it('inserts every row and writes one audit row for the whole batch', async () => {
    const fake = fakeClient()
    const result = await makeProvider(fake).insertReceiptLineItems('company-1', [
      entry({ receipt_name: 'TIN TABS' }),
      entry({ receipt_name: 'PRIMER', material_id: 'S204' }),
    ])

    expect(result).toMatchObject({ ok: true, attemptedCount: 2, insertedCount: 2 })
    expect(fake.lineItemInsertCalls).toHaveLength(2)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ tool_name: 'insertReceiptLineItems' })
  })

  it('reports a partial failure without blocking the other rows', async () => {
    const fake = fakeClient({ lineItemInsertErrors: { 1: 'null value in column "receipt_id"' } })
    const result = await makeProvider(fake).insertReceiptLineItems('company-1', [
      entry({ receipt_name: 'ONE' }),
      entry({ receipt_name: 'TWO' }),
    ])

    expect(result.ok).toBe(false)
    expect(result.insertedCount).toBe(1)
    expect(result.failedRows).toHaveLength(1)
    expect(result.failedRows[0].error).toContain('receipt_id')
    expect(fake.auditLogCalls).toHaveLength(1)
  })

  it('only ever writes the columns this boundary is allowed to set', async () => {
    const fake = fakeClient()
    await makeProvider(fake).insertReceiptLineItems('company-1', [
      { row: { ...lineItemRow(), ...({ applied: true, id: 'chosen-id' } as Partial<BedrockReceiptLineItemInsert>) }, matchReason: 'irrelevant here' },
    ])

    expect(Object.keys(fake.lineItemInsertCalls[0]).sort()).toEqual([
      'match_confidence', 'material_id', 'qty', 'receipt_id', 'receipt_name', 'total_cost', 'unit', 'unit_cost',
    ])
  })

  describe('ownership check', () => {
    // Fix requested after review: don't leave this safe only by coincidence
    // of today's one caller always passing a same-request receipt id.
    // Mirrors insertPayment's invoiceBelongsToCompany check exactly.

    it('refuses the whole batch when a line item names a receipt belonging to a different company', async () => {
      const fake = fakeClient({ ownedReceiptIds: ['receipt-1'] })
      const result = await makeProvider(fake).insertReceiptLineItems('company-1', [
        entry({ receipt_id: 'foreign-receipt-999' }),
      ])

      expect(result.ok).toBe(false)
      expect(result.insertedCount).toBe(0)
      expect(result.failedRows[0].error).toMatch(/refused.*foreign-receipt-999/)
      expect(fake.lineItemInsertCalls).toHaveLength(0)
    })

    it('refuses the whole batch when the receipt id does not exist at all', async () => {
      const fake = fakeClient({ ownedReceiptIds: [] })
      const result = await makeProvider(fake).insertReceiptLineItems('company-1', [entry()])

      expect(result.ok).toBe(false)
      expect(fake.lineItemInsertCalls).toHaveLength(0)
    })

    it('audits the refusal with status denied, the same way insertPayment audits a foreign invoice', async () => {
      const fake = fakeClient({ ownedReceiptIds: [] })
      await makeProvider(fake).insertReceiptLineItems('company-1', [entry()])

      expect(fake.auditLogCalls).toHaveLength(1)
      expect(fake.auditLogCalls[0]).toMatchObject({ status: 'denied', tool_name: 'insertReceiptLineItems' })
    })

    it('refuses ALL rows in the batch even when only one names a foreign receipt', async () => {
      // Fail-closed on the whole attempt, not a partial insert around a
      // security check -- a batch that named even one foreign receipt is
      // not trustworthy piecemeal.
      const fake = fakeClient({ ownedReceiptIds: ['receipt-1'] })
      const result = await makeProvider(fake).insertReceiptLineItems('company-1', [
        entry({ receipt_id: 'receipt-1' }),
        entry({ receipt_id: 'foreign-receipt-999' }),
      ])

      expect(result.ok).toBe(false)
      expect(result.attemptedCount).toBe(2)
      expect(result.insertedCount).toBe(0)
      expect(fake.lineItemInsertCalls).toHaveLength(0)
    })

    it('checks each distinct receipt id only once, not once per row', async () => {
      const fake = fakeClient({ ownedReceiptIds: ['receipt-1'] })
      await makeProvider(fake).insertReceiptLineItems('company-1', [
        entry({ receipt_id: 'receipt-1', receipt_name: 'A' }),
        entry({ receipt_id: 'receipt-1', receipt_name: 'B' }),
        entry({ receipt_id: 'receipt-1', receipt_name: 'C' }),
      ])

      expect(fake.receiptLookupCalls).toEqual(['receipt-1'])
    })

    it('proceeds normally when the receipt is legitimately owned', async () => {
      const fake = fakeClient({ ownedReceiptIds: ['receipt-1'] })
      const result = await makeProvider(fake).insertReceiptLineItems('company-1', [entry()])
      expect(result.ok).toBe(true)
      expect(fake.lineItemInsertCalls).toHaveLength(1)
    })
  })

  describe('match reason', () => {
    // Fix requested after review: why a line item did or didn't link to a
    // materials row should be queryable from audit_logs afterward, not only
    // visible in the WhatsApp turn that proposed it.

    it('writes matchReason into the audit log input for every row', async () => {
      const fake = fakeClient()
      await makeProvider(fake).insertReceiptLineItems('company-1', [
        entry({ receipt_name: 'TIN TABS', material_id: null }, 'No existing match — created new materials catalog row R123_0.'),
        entry({ receipt_name: 'PRIMER', material_id: 'S204' }, 'Matched existing material S204 ("Interior primer").'),
      ])

      const auditedRows = (fake.auditLogCalls[0].input as { rows: Array<Record<string, unknown>> }).rows
      expect(auditedRows[0].match_reason).toMatch(/created new materials catalog row/)
      expect(auditedRows[1].match_reason).toMatch(/Matched existing material S204/)
    })

    it('never writes match_reason onto the actual receipt_line_items row', async () => {
      const fake = fakeClient()
      await makeProvider(fake).insertReceiptLineItems('company-1', [entry({}, 'some reason')])
      expect(fake.lineItemInsertCalls[0]).not.toHaveProperty('match_reason')
    })

    it('records the reason even on a refused (foreign-receipt) batch, so the audit trail explains the denial too', async () => {
      const fake = fakeClient({ ownedReceiptIds: [] })
      await makeProvider(fake).insertReceiptLineItems('company-1', [
        entry({ receipt_id: 'foreign-receipt-999' }, 'Matched existing material S204 ("Interior primer").'),
      ])

      const auditedRows = (fake.auditLogCalls[0].input as { rows: Array<Record<string, unknown>> }).rows
      expect(auditedRows[0].match_reason).toMatch(/Matched existing material S204/)
    })
  })
})

describe('BedrockWriteProvider.insertMaterial', () => {
  it('inserts a new row and writes an audit row', async () => {
    const fake = fakeClient()
    const result = await makeProvider(fake).insertMaterial('company-1', materialRow())

    expect(result).toMatchObject({ ok: true, insertedCount: 1, insertedIds: ['R1783613593116_0'] })
    expect(fake.materialInsertCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ tool_name: 'insertMaterial' })
  })

  it('never carries company_id — the table has no such column', async () => {
    const fake = fakeClient()
    await makeProvider(fake).insertMaterial('company-1', materialRow())
    expect(fake.materialInsertCalls[0]).not.toHaveProperty('company_id')
  })

  it('only ever writes the columns this boundary is allowed to set', async () => {
    const fake = fakeClient()
    await makeProvider(fake).insertMaterial('company-1', {
      ...materialRow(),
      ...({ company_id: 'foreign-company-999', created_at: '1999-01-01' } as Partial<BedrockMaterialInsert>),
    })

    expect(Object.keys(fake.materialInsertCalls[0]).sort()).toEqual([
      'category', 'division_code', 'division_name', 'id', 'name', 'notes', 'supplier', 'unit', 'unit_cost',
    ])
  })

  it('reports a failed insert as failed, and still audits the attempt', async () => {
    const fake = fakeClient({ materialInsertError: 'duplicate key value violates unique constraint' })
    const result = await makeProvider(fake).insertMaterial('company-1', materialRow())

    expect(result).toMatchObject({ ok: false, insertedCount: 0 })
    expect(result.failedRows[0].error).toContain('duplicate key')
    expect(fake.auditLogCalls).toHaveLength(1)
  })
})
