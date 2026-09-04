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
  const lineItemInserts: Record<string, unknown>[] = []
  const materialInserts: Record<string, unknown>[] = []

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
    async insertReceiptLineItems(_companyId: string, rows: Record<string, unknown>[]) {
      lineItemInserts.push(...rows)
      return {
        ok: true, attemptedCount: rows.length, insertedCount: rows.length,
        insertedIds: rows.map((_, i) => `line-${i}`), failedRows: [], auditLogWritten: true, auditLogError: null,
      }
    },
    async insertMaterial(_companyId: string, row: Record<string, unknown>) {
      materialInserts.push(row)
      const forced = over.materialResult as Record<string, unknown> | undefined
      return forced ?? {
        ok: true, attemptedCount: 1, insertedCount: 1, insertedIds: [row.id as string],
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
    findReceiptMedia: (async () => (over.photo ?? PHOTO)) as never,
    resolveJobBy: (async () => (over.job ?? { match: 'one', count: 1, candidates: [{ id: 'project-sundancer', name: 'Sundancer' }] })) as never,
    findMaterialBy: (async () => (over.material ?? { match: 'none', count: 0, candidates: [] })) as never,
    ...(over.deps as object ?? {}),
  }

  return { tool: makeLogReceipt(deps), uploads, inserts, lineItemInserts, materialInserts }
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

describe('log_receipt — PDFs', () => {
  const PDF = { mediaId: 'wa-media-pdf-1', mimeType: 'application/pdf', waMessageId: 'wamid.PDF', arrivedAt: '2026-09-04T12:00:00Z' }

  it('records a PDF receipt the same way as a photo', async () => {
    const h = harness({
      photo: PDF,
      deps: { downloadMedia: (async () => ({ base64: Buffer.from('%PDF-1.4').toString('base64'), mimeType: 'application/pdf' })) as never },
    })
    const res = await h.tool.execute({ vendor: 'Bahamas Hardware', total_amount: 200 }, ctx)

    expect(res.ok).toBe(true)
    expect(h.uploads[0].filename).toBe('wa-media-pdf-1.pdf')
    expect(h.uploads[0].mimeType).toBe('application/pdf')
  })
})

describe('log_receipt — line items and materials', () => {
  it('links a line item to a single confident existing-material match', async () => {
    const h = harness({ material: { match: 'one', count: 1, candidates: [{ id: 'S193', name: 'Porcelain tile 18x18', category: 'Tile', unit: 'EA', unitCost: 6.63, supplier: 'Nassau' }] } })
    const res = await h.tool.execute(
      { vendor: 'X', total_amount: 50, line_items: [{ description: 'Porcelain tile 18x18', quantity: 5, unit_price: 6.63 }] },
      ctx,
    )

    expect(res.ok).toBe(true)
    expect(h.lineItemInserts).toHaveLength(1)
    expect(h.lineItemInserts[0]).toMatchObject({ material_id: 'S193', match_confidence: 'high', receipt_name: 'Porcelain tile 18x18', qty: 5, unit_cost: 6.63, total_cost: 33.15 })
    expect(h.materialInserts).toHaveLength(0)
  })

  it('creates a new R###-style materials row when nothing matches and a price is known', async () => {
    const h = harness({ material: { match: 'none', count: 0, candidates: [] } })
    const res = await h.tool.execute(
      { vendor: 'Buywise Hardware', receipt_date: '2026-09-04', total_amount: 10, line_items: [{ description: 'TIN TABS', unit: 'EA', unit_price: 4.75, category: 'Metal Fasteners' }] },
      ctx,
    )

    expect(res.ok).toBe(true)
    expect(h.materialInserts).toHaveLength(1)
    expect(h.materialInserts[0]).toMatchObject({
      division_name: 'From Receipt',
      division_code: '05', // metal fastener keyword match
      category: 'Metal Fasteners',
      name: 'TIN TABS',
      unit: 'EA',
      unit_cost: 4.75,
      supplier: 'Buywise Hardware',
      notes: 'Added from receipt 2026-09-04',
    })
    expect(String(h.materialInserts[0].id)).toMatch(/^R\d+_0$/)
    expect(h.lineItemInserts[0].material_id).toBe(h.materialInserts[0].id)
  })

  it('leaves an ambiguous materials match unlinked rather than guessing', async () => {
    const h = harness({
      material: { match: 'many', count: 2, candidates: [{ id: 'S1', name: 'a', category: null, unit: null, unitCost: 1, supplier: null }, { id: 'S2', name: 'b', category: null, unit: null, unitCost: 1, supplier: null }] },
    })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10, line_items: [{ description: 'Generic pipe fitting', unit_price: 12 }] }, ctx)

    expect(res.ok).toBe(true)
    expect(h.materialInserts).toHaveLength(0)
    expect(h.lineItemInserts[0].material_id).toBeNull()
    expect(h.lineItemInserts[0].match_confidence).toBe('none')
    const outcome = (res.data as Record<string, unknown>).line_items as Array<Record<string, unknown>>
    expect(String(outcome[0].reason)).toMatch(/2 similar materials found/)
  })

  it('records a line item with no legible price without creating a materials row', async () => {
    const h = harness({ material: { match: 'none', count: 0, candidates: [] } })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10, line_items: [{ description: 'Something illegible' }] }, ctx)

    expect(res.ok).toBe(true)
    expect(h.materialInserts).toHaveLength(0)
    expect(h.lineItemInserts[0]).toMatchObject({ material_id: null, unit_cost: null, total_cost: null })
    const outcome = (res.data as Record<string, unknown>).line_items as Array<Record<string, unknown>>
    expect(String(outcome[0].reason)).toMatch(/No legible unit price/)
  })

  it('refuses a line item with no description', async () => {
    const h = harness()
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10, line_items: [{ description: '  ' }] }, ctx)
    expect(res.ok).toBe(false)
    expect(h.inserts).toHaveLength(0)
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
    const h = harness({ deps: { findReceiptMedia: (async () => ({ error: 'I do not have a recent photo or PDF to attach to this. Send the receipt and I will record it.' })) as never } })
    const res = await h.tool.execute({ vendor: 'X', total_amount: 10 }, ctx)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Send the receipt/)
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
