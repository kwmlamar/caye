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
  } = {}
) {
  const lineItemInsertCalls: Record<string, unknown>[] = []
  const materialInsertCalls: Record<string, unknown>[] = []
  const auditLogCalls: Record<string, unknown>[] = []

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

  return { client, lineItemInsertCalls, materialInsertCalls, auditLogCalls }
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
      lineItemRow({ receipt_name: 'TIN TABS' }),
      lineItemRow({ receipt_name: 'PRIMER', material_id: 'S204' }),
    ])

    expect(result).toMatchObject({ ok: true, attemptedCount: 2, insertedCount: 2 })
    expect(fake.lineItemInsertCalls).toHaveLength(2)
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ tool_name: 'insertReceiptLineItems' })
  })

  it('reports a partial failure without blocking the other rows', async () => {
    const fake = fakeClient({ lineItemInsertErrors: { 1: 'null value in column "receipt_id"' } })
    const result = await makeProvider(fake).insertReceiptLineItems('company-1', [
      lineItemRow({ receipt_name: 'ONE' }),
      lineItemRow({ receipt_name: 'TWO', receipt_id: '' }),
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
      { ...lineItemRow(), ...({ applied: true, id: 'chosen-id' } as Partial<BedrockReceiptLineItemInsert>) },
    ])

    expect(Object.keys(fake.lineItemInsertCalls[0]).sort()).toEqual([
      'match_confidence', 'material_id', 'qty', 'receipt_id', 'receipt_name', 'total_cost', 'unit', 'unit_cost',
    ])
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
