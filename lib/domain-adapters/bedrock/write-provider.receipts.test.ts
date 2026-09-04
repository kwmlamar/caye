import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BedrockWriteProvider,
  BEDROCK_DOCUMENTS_BUCKET,
  BEDROCK_RECEIPT_MAX_BYTES,
  type BedrockReceiptInsert,
} from './write-provider'
import type { BedrockConnection } from './types'

const connection: BedrockConnection = {
  workspaceId: 'ws-1',
  companyId: 'company-1',
  supabaseUrl: 'https://bedrock.invalid',
  serviceRoleKey: 'super-secret-key',
}

const PUBLIC_URL_BASE = `https://bedrock.invalid/storage/v1/object/public/${BEDROCK_DOCUMENTS_BUCKET}`

/**
 * A real ODS-shaped receipt: a materials run with no job named, which is the
 * ordinary case — five of the eight backfilled invoices had no project link
 * either, and the live receipts table has no project_id on any of its six rows.
 */
function receiptRow(overrides: Partial<BedrockReceiptInsert> = {}): BedrockReceiptInsert {
  return {
    image_url: `${PUBLIC_URL_BASE}/receipts/company-1/receipt.jpg`,
    project_id: null,
    submitted_by: 'profile-lamar',
    vendor: 'Bahamas Hardware',
    receipt_date: '2026-09-03',
    total_amount: 418.72,
    notes: null,
    company_id: 'company-1',
    ...overrides,
  }
}

function fakeClient(
  options: {
    receiptInsertError?: string
    uploadError?: string
    publicUrl?: string | null
  } = {}
) {
  const receiptInsertCalls: Record<string, unknown>[] = []
  const auditLogCalls: Record<string, unknown>[] = []
  const uploadCalls: { path: string; contentType?: string; upsert?: boolean; byteLength: number }[] = []

  const client = {
    from(table: string) {
      if (table === 'receipts') {
        return {
          insert(row: Record<string, unknown>) {
            receiptInsertCalls.push(row)
            return {
              select() {
                return {
                  async single() {
                    return options.receiptInsertError
                      ? { data: null, error: { message: options.receiptInsertError } }
                      : { data: { id: 'receipt-1' }, error: null }
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
    storage: {
      from(bucket: string) {
        if (bucket !== BEDROCK_DOCUMENTS_BUCKET) {
          throw new Error(`fakeClient: unexpected bucket "${bucket}"`)
        }
        return {
          async upload(path: string, bytes: Uint8Array, opts?: { contentType?: string; upsert?: boolean }) {
            uploadCalls.push({
              path,
              contentType: opts?.contentType,
              upsert: opts?.upsert,
              byteLength: bytes.byteLength,
            })
            return options.uploadError ? { error: { message: options.uploadError } } : { error: null }
          },
          getPublicUrl(path: string) {
            if (options.publicUrl === null) return { data: { publicUrl: '' } }
            return { data: { publicUrl: options.publicUrl ?? `${PUBLIC_URL_BASE}/${path}` } }
          },
        }
      },
    },
  } as unknown as SupabaseClient

  return { client, receiptInsertCalls, auditLogCalls, uploadCalls }
}

function makeProvider(fake: ReturnType<typeof fakeClient>) {
  return new BedrockWriteProvider(connection, () => fake.client)
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22])

describe('BedrockWriteProvider.uploadReceiptImage', () => {
  it('stores under the company id and returns a public URL', async () => {
    const fake = fakeClient()
    const result = await makeProvider(fake).uploadReceiptImage('company-1', {
      bytes: JPEG,
      mimeType: 'image/jpeg',
      filename: 'wa-media-77.jpg',
    })

    expect(result).toMatchObject({ ok: true, path: 'receipts/company-1/wa-media-77.jpg' })
    expect(fake.uploadCalls).toHaveLength(1)
    expect(fake.uploadCalls[0].contentType).toBe('image/jpeg')
  })

  it('never overwrites an existing object', async () => {
    // upsert:false is the whole reason this stays inside the class's
    // append-only rule. A name collision must fail, not replace somebody
    // else's receipt.
    const fake = fakeClient()
    await makeProvider(fake).uploadReceiptImage('company-1', {
      bytes: JPEG,
      mimeType: 'image/jpeg',
      filename: 'x.jpg',
    })
    expect(fake.uploadCalls[0].upsert).toBe(false)
  })

  it('scopes the path by company so two companies cannot collide', async () => {
    const fake = fakeClient()
    await makeProvider(fake).uploadReceiptImage('company-2', {
      bytes: JPEG,
      mimeType: 'image/jpeg',
      filename: 'same-name.jpg',
    })
    expect(fake.uploadCalls[0].path).toBe('receipts/company-2/same-name.jpg')
  })

  it('refuses a mime type the bucket does not accept, without calling storage', async () => {
    // image/gif is the trap: Caye can read one, the bucket rejects it. Better
    // a clear refusal here than a storage error the caller has to decode.
    const fake = fakeClient()
    const result = await makeProvider(fake).uploadReceiptImage('company-1', {
      bytes: JPEG,
      mimeType: 'image/gif',
      filename: 'x.gif',
    })

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: expect.stringContaining('not an accepted receipt image type') })
    expect(fake.uploadCalls).toHaveLength(0)
  })

  it('accepts the types the bucket actually allows', async () => {
    for (const mimeType of ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf', 'image/heic', 'image/heif']) {
      const fake = fakeClient()
      const result = await makeProvider(fake).uploadReceiptImage('company-1', {
        bytes: JPEG,
        mimeType,
        filename: 'x',
      })
      expect(result.ok, `${mimeType} should be accepted`).toBe(true)
    }
  })

  it('refuses an oversized image before uploading it', async () => {
    const fake = fakeClient()
    const result = await makeProvider(fake).uploadReceiptImage('company-1', {
      bytes: new Uint8Array(BEDROCK_RECEIPT_MAX_BYTES + 1),
      mimeType: 'image/jpeg',
      filename: 'huge.jpg',
    })

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: expect.stringContaining('over the') })
    expect(fake.uploadCalls).toHaveLength(0)
  })

  it('reports an upload failure rather than returning a URL for nothing', async () => {
    const fake = fakeClient({ uploadError: 'bucket unavailable' })
    const result = await makeProvider(fake).uploadReceiptImage('company-1', {
      bytes: JPEG,
      mimeType: 'image/jpeg',
      filename: 'x.jpg',
    })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('bucket unavailable') })
  })

  it('fails when no public URL can be resolved, rather than inventing one', async () => {
    const fake = fakeClient({ publicUrl: null })
    const result = await makeProvider(fake).uploadReceiptImage('company-1', {
      bytes: JPEG,
      mimeType: 'image/jpeg',
      filename: 'x.jpg',
    })
    expect(result).toMatchObject({ ok: false })
  })
})

describe('BedrockWriteProvider.insertReceipt', () => {
  it('forces the resolved company id, ignoring whatever the caller passed', async () => {
    const fake = fakeClient()
    await makeProvider(fake).insertReceipt('company-1', receiptRow({ company_id: 'foreign-company-999' }))

    expect(fake.receiptInsertCalls).toHaveLength(1)
    expect(fake.receiptInsertCalls[0].company_id).toBe('company-1')
  })

  it('never sets status — a receipt Caye records is pending by definition', async () => {
    // The column defaults to 'pending' and its CHECK allows 'processed'.
    // Declaring a receipt processed would be asserting a reconciliation that
    // has not happened.
    const fake = fakeClient()
    await makeProvider(fake).insertReceipt('company-1', receiptRow())

    expect(fake.receiptInsertCalls[0]).not.toHaveProperty('status')
  })

  it('records a receipt whose job nobody could name, rather than guessing one', async () => {
    const fake = fakeClient()
    const result = await makeProvider(fake).insertReceipt('company-1', receiptRow({ project_id: null }))

    expect(result.ok).toBe(true)
    expect(fake.receiptInsertCalls[0].project_id).toBeNull()
  })

  it('carries the job link through when one was actually given', async () => {
    const fake = fakeClient()
    await makeProvider(fake).insertReceipt('company-1', receiptRow({ project_id: 'project-sundancer' }))
    expect(fake.receiptInsertCalls[0].project_id).toBe('project-sundancer')
  })

  it('writes an audit row for a successful insert', async () => {
    const fake = fakeClient()
    const result = await makeProvider(fake).insertReceipt('company-1', receiptRow())

    expect(result).toMatchObject({ ok: true, insertedCount: 1, insertedIds: ['receipt-1'] })
    expect(fake.auditLogCalls).toHaveLength(1)
    expect(fake.auditLogCalls[0]).toMatchObject({ tool_name: 'insertReceipt' })
  })

  it('reports a failed insert as failed, and still audits the attempt', async () => {
    const fake = fakeClient({ receiptInsertError: 'null value in column "image_url"' })
    const result = await makeProvider(fake).insertReceipt('company-1', receiptRow())

    expect(result).toMatchObject({ ok: false, insertedCount: 0 })
    expect(result.failedRows[0].error).toContain('image_url')
    expect(fake.auditLogCalls).toHaveLength(1)
  })

  it('only ever writes the columns this boundary is allowed to set', async () => {
    const fake = fakeClient()
    await makeProvider(fake).insertReceipt('company-1', {
      ...receiptRow(),
      // A caller trying to smuggle extra columns through must not reach the table.
      ...({ status: 'processed', id: 'chosen-id', created_at: '1999-01-01' } as Partial<BedrockReceiptInsert>),
    })

    expect(Object.keys(fake.receiptInsertCalls[0]).sort()).toEqual([
      'company_id', 'image_url', 'notes', 'project_id', 'receipt_date', 'submitted_by', 'total_amount', 'vendor',
    ])
  })
})
