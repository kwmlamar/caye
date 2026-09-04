import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => { throw new Error('no db in tests') },
}))

import { makeLogReceipt } from './log-receipt'
import type { ToolContext } from '../types'

const ctx: ToolContext = { workspaceId: 'ws-1', callerRole: 'staff', requestId: 'req-1', operatorId: 31 }

const PHOTO = {
  mediaId: 'wa-media-7712',
  mimeType: 'image/jpeg',
  waMessageId: 'wamid.ABC',
  arrivedAt: '2026-09-03T18:31:00Z',
}

function harness(over: Record<string, unknown> = {}) {
  const uploads: { filename: string; mimeType: string; byteLength: number }[] = []
  const inserts: Record<string, unknown>[] = []

  const provider = {
    async uploadReceiptImage(_companyId: string, p: { bytes: Uint8Array; mimeType: string; filename: string }) {
      uploads.push({ filename: p.filename, mimeType: p.mimeType, byteLength: p.bytes.byteLength })
      const forced = over.uploadResult as { ok: false; error: string } | undefined
      return forced ?? { ok: true as const, url: `https://bedrock.invalid/public/documents/receipts/company-1/${p.filename}`, path: `receipts/company-1/${p.filename}` }
    },
    async insertReceipt(_companyId: string, row: Record<string, unknown>) {
      inserts.push(row)
      return (over.insertResult as Record<string, unknown> | undefined) ?? {
        ok: true, attemptedCount: 1, insertedCount: 1, insertedIds: ['receipt-1'],
        failedRows: [], auditLogWritten: true, auditLogError: null,
      }
    },
  }

  const deps = {
    getWriteProvider: (async () => ({
      provider,
      companyId: 'company-1',
      identityFor: () => ({ profileId: 'profile-lamar' }),
    })) as never,
    getAdapter: (() => ({})) as never,
    downloadMedia: (async () => ({ base64: Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64'), mimeType: 'image/jpeg' })) as never,
    findPhoto: (async () => (over.photo ?? PHOTO)) as never,
    resolveJobBy: (async () => (over.job ?? { match: 'one', count: 1, candidates: [{ id: 'project-sundancer', name: 'Sundancer' }] })) as never,
    ...(over.deps as object ?? {}),
  }

  return { tool: makeLogReceipt(deps), uploads, inserts }
}

describe('log_receipt — what reaches the ledger', () => {
  it('attaches the photo and records what was actually read', async () => {
    const h = harness()
    const res = await h.tool.execute({ vendor: 'Bahamas Hardware', total_amount: 418.72, receipt_date: '2026-09-03', project: 'Sundancer' }, ctx)

    expect(res.ok).toBe(true)
    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]).toMatchObject({
      vendor: 'Bahamas Hardware',
      total_amount: 418.72,
      receipt_date: '2026-09-03',
      project_id: 'project-sundancer',
      submitted_by: 'profile-lamar',
    })
    expect(String(h.inserts[0].image_url)).toContain(PHOTO.mediaId)
  })

  it('names the stored file after the media id, so the same photo cannot be logged twice', async () => {
    // upsert:false at the storage layer turns a repeat into a collision. The
    // deterministic name is what makes that collision happen at all.
    const h = harness()
    await h.tool.execute({ vendor: 'X', total_amount: 1 }, ctx)
    expect(h.uploads[0].filename).toBe('wa-media-7712.jpg')
  })

  it('records a receipt with no job rather than guessing at an ambiguous name', async () => {
    const h = harness({ job: { match: 'many', count: 3, candidates: [] } })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 12, project: 'villa' }, ctx)

    expect(res.ok).toBe(true)
    expect(h.inserts[0].project_id).toBeNull()
    expect(String((res.data as Record<string, unknown>).project_note)).toMatch(/matches 3 jobs/)
  })

  it('records what it could read and says plainly what is missing', async () => {
    // A receipt with an unreadable total is still worth filing against a job.
    // Reporting it as complete would be the wrong-zero problem again.
    const h = harness({ job: { match: 'none', count: 0, candidates: [] } })
    const res = await h.tool.execute({ vendor: 'Bahamas Hardware' }, ctx)

    expect(res.ok).toBe(true)
    expect(h.inserts[0].total_amount).toBeNull()
    expect((res.data as Record<string, unknown>).not_recorded).toEqual(['total', 'date', 'job'])
    expect(String((res.data as Record<string, unknown>).note)).toMatch(/Not on the record: total, date, job/)
  })
})

describe('log_receipt — what it refuses', () => {
  it('writes nothing when the photo cannot be retrieved', async () => {
    // A receipt is not worth having without its image, and image_url is NOT
    // NULL anyway — there is no half-record to fall back to.
    const h = harness({ deps: { downloadMedia: (async () => { throw new Error('media expired') }) as never } })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10 }, ctx)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/could not be retrieved/i)
    expect(h.inserts).toHaveLength(0)
  })

  it('writes nothing when the image cannot be stored', async () => {
    const h = harness({ uploadResult: { ok: false, error: 'refused: image/gif is not an accepted receipt image type' } })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10 }, ctx)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not an accepted receipt image type/)
    expect(h.inserts).toHaveLength(0)
  })

  it('asks for a photo instead of recording a receipt without one', async () => {
    const h = harness({ deps: { findPhoto: (async () => ({ error: 'I do not have a recent photo to attach to this. Send the receipt photo and I will record it.' })) as never } })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10 }, ctx)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Send the receipt photo/)
    expect(h.uploads).toHaveLength(0)
  })

  it('refuses a total that is not a positive number rather than storing a guess', async () => {
    const h = harness()
    for (const total of [0, -5, Number.NaN]) {
      const res = await h.tool.execute({ vendor: 'X', total_amount: total }, ctx)
      expect(res.ok, `total ${total}`).toBe(false)
    }
    expect(h.inserts).toHaveLength(0)
  })

  it('refuses a malformed date', async () => {
    const h = harness()
    const res = await h.tool.execute({ vendor: 'X', receipt_date: '3rd Sept' }, ctx)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/YYYY-MM-DD/)
  })

  it('reports a failed insert as failed and never as filed', async () => {
    const h = harness({
      insertResult: { ok: false, attemptedCount: 1, insertedCount: 0, insertedIds: [], failedRows: [{ index: 0, row: {}, error: 'permission denied' }], auditLogWritten: true, auditLogError: null },
    })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10 }, ctx)

    expect(res.ok).toBe(false)
    expect(String((res.data as Record<string, unknown>).note)).toMatch(/Nothing was recorded/)
  })
})

describe('log_receipt — how it is exposed', () => {
  it('is staged for confirmation, not executed on sight', () => {
    expect(makeLogReceipt().risk).toBe('high')
  })

  it('is available to the office, not only the owner', () => {
    // Lamar runs the office and does the data entry; a receipt tool he cannot
    // reach is a receipt tool nobody uses.
    expect(makeLogReceipt().roles).toContain('staff')
  })

  it('requires nothing, so an unreadable receipt can still be filed', () => {
    expect(makeLogReceipt().inputSchema.required ?? []).toEqual([])
  })
})
