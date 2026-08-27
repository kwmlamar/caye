import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const enqueueOperation = vi.hoisted(() => vi.fn().mockResolvedValue({ queued: true, alreadyQueued: false }))
vi.mock('@/lib/pending-operations', () => ({ enqueueOperation }))

const uploadArtifactBytes = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }))
vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return { ...actual, uploadArtifactBytes }
})

const processArtifact = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, status: 'completed', skipped: false }))
vi.mock('./process', () => ({ processArtifact }))

/**
 * Minimal thenable query-builder fake tailored to ingest.ts's exact chains:
 *   dedup lookup: .from('business_artifacts').select('*').eq().eq().eq().maybeSingle()
 *   insert:       .from('business_artifacts').insert(payload).select('*').single()
 *   patch:        .from('business_artifacts').update(payload).eq('id', id)[.select('*').single()]
 *
 * `rows` is a mutable in-memory table so an insert/update performed mid-test
 * is visible to a later dedup lookup in the SAME test — needed to prove the
 * self-heal path reuses the same row across two ingestArtifact() calls.
 */
function fakeSupabase(initialRows: Record<string, unknown>[] = []) {
  const rows = [...initialRows]
  const eqCalls: Array<[string, unknown]> = []
  const insertCalls: unknown[] = []
  const updateCalls: unknown[] = []
  let nextId = 1
  let forceStoredPatchFailure = false

  function matches(row: Record<string, unknown>, filters: Array<[string, unknown]>) {
    return filters.every(([col, val]) => row[col] === val)
  }

  const from = vi.fn(() => ({
    select: vi.fn(() => {
      const filters: Array<[string, unknown]> = []
      const chain: Record<string, unknown> = {}
      chain.eq = vi.fn((col: string, val: unknown) => {
        eqCalls.push([col, val])
        filters.push([col, val])
        return chain
      })
      chain.maybeSingle = vi.fn(() => Promise.resolve({ data: rows.find((r) => matches(r, filters)) ?? null, error: null }))
      return chain
    }),
    insert: vi.fn((payload: Record<string, unknown>) => {
      insertCalls.push(payload)
      const existingCollision = rows.find(
        (r) =>
          r.workspace_id === payload.workspace_id &&
          r.source_channel === payload.source_channel &&
          payload.provider_attachment_id != null &&
          r.provider_attachment_id === payload.provider_attachment_id
      )
      return {
        select: vi.fn(() => ({
          single: vi.fn(() => {
            if (existingCollision) {
              return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
            }
            const row = {
              id: `artifact-${nextId++}`,
              processing_version: 1,
              storage_state: 'pending',
              ...payload,
            }
            rows.push(row)
            return Promise.resolve({ data: row, error: null })
          }),
        })),
      }
    }),
    update: vi.fn((payload: Record<string, unknown>) => {
      const chain: Record<string, unknown> = {}
      chain.eq = vi.fn((col: string, val: unknown) => {
        updateCalls.push({ payload, col, val })
        const row = rows.find((r) => r[col] === val)
        // Injected failure targets only the "commit storage_state='stored'"
        // patch — one-shot, so a subsequent retry in the same test succeeds.
        const shouldFail = payload.storage_state === 'stored' && forceStoredPatchFailure
        if (shouldFail) forceStoredPatchFailure = false
        if (!shouldFail && row) Object.assign(row, payload)
        chain.select = vi.fn(() => ({
          single: vi.fn(() =>
            Promise.resolve(
              shouldFail ? { data: null, error: { message: 'transient write failure' } } : { data: row ?? null, error: null }
            )
          ),
        }))
        // Bare `await ...update().eq()` with no further chain (no .select()).
        chain.then = (onfulfilled?: (v: unknown) => unknown) =>
          Promise.resolve(shouldFail ? { error: { message: 'transient write failure' } } : { error: null }).then(onfulfilled)
        return chain
      })
      return chain
    }),
  }))

  return {
    client: { from },
    eqCalls,
    insertCalls,
    updateCalls,
    rows,
    forceNextStoredPatchFailure: () => {
      forceStoredPatchFailure = true
    },
  }
}

let currentClient: ReturnType<typeof fakeSupabase>['client']
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => currentClient }))

import { ingestArtifact } from './ingest'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

beforeEach(() => {
  enqueueOperation.mockClear().mockResolvedValue({ queued: true, alreadyQueued: false })
  uploadArtifactBytes.mockClear().mockResolvedValue({ ok: true })
  processArtifact.mockClear().mockResolvedValue({ ok: true, status: 'completed', skipped: false })
})

describe('ingestArtifact — idempotent ingestion (#87 acceptance test 1)', () => {
  it('returns the SAME artifact for a duplicate provider_attachment_id once bytes are already durably stored — no re-upload, no re-enqueue', async () => {
    const existing = { id: 'artifact-existing', workspace_id: 'ws-1', source_channel: 'whatsapp_operator', provider_attachment_id: 'wamid.same-attachment', processing_version: 1, storage_state: 'stored' }
    const fake = fakeSupabase([existing])
    currentClient = fake.client

    const result = await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.same-attachment',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.deduped).toBe(true)
    expect(result.artifact.id).toBe('artifact-existing')
    expect(fake.insertCalls).toHaveLength(0)
    expect(uploadArtifactBytes).not.toHaveBeenCalled()
    expect(enqueueOperation).not.toHaveBeenCalled()
  })

  it('scopes the dedup lookup by workspace_id, source_channel, AND provider_attachment_id — never cross-workspace (acceptance test 2)', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client

    await ingestArtifact({
      workspaceId: 'ws-2',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.same-attachment', // same provider id as some OTHER workspace's artifact would use
    })

    expect(fake.eqCalls).toContainEqual(['workspace_id', 'ws-2'])
    expect(fake.eqCalls).toContainEqual(['source_channel', 'whatsapp_operator'])
    expect(fake.eqCalls).toContainEqual(['provider_attachment_id', 'wamid.same-attachment'])
    expect(fake.insertCalls).toHaveLength(1)
  })

  it('rejects an oversized file before ever touching storage or the database', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client

    const oversized = Buffer.alloc(6 * 1024 * 1024, 0xff) // > 5MB image cap
    oversized[0] = 0xff
    oversized[1] = 0xd8
    oversized[2] = 0xff // JPEG magic bytes

    const result = await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: oversized,
      declaredMimeType: 'image/jpeg',
      filename: null,
      providerAttachmentId: null,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errorCode).toBe('TOO_LARGE')
    expect(fake.insertCalls).toHaveLength(0)
    expect(uploadArtifactBytes).not.toHaveBeenCalled()
  })
})

describe('BLOCKER 1 — storage-upload self-heal (#87 tests A/B)', () => {
  it('A: upload failure, then a provider retry, self-heals using the SAME artifact id — never a fake dedup success', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client
    uploadArtifactBytes.mockResolvedValueOnce({ ok: false, error: 'network blip' })

    const first = await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.retry-me',
    })

    expect(first.ok).toBe(false)
    if (first.ok) throw new Error('unreachable')
    expect(first.errorCode).toBe('UPLOAD_FAILED')
    // The row exists, but nothing may ever treat it as successfully ingested.
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].storage_state).toBe('failed')
    expect(enqueueOperation).not.toHaveBeenCalled() // never enqueue understanding for bytes that don't exist

    // Provider (webhook) retry redelivers the same attachment.
    uploadArtifactBytes.mockResolvedValueOnce({ ok: true })
    const second = await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.retry-me',
    })

    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.artifact.id).toBe(first.error ? fake.rows[0].id : second.artifact.id) // sanity: no crash
    expect(second.artifact.id).toBe(fake.rows[0].id) // SAME canonical row, never a second one
    expect(fake.rows).toHaveLength(1) // still exactly one artifact for this provider attachment
    expect(fake.rows[0].storage_state).toBe('stored')
    expect(enqueueOperation).toHaveBeenCalledTimes(1) // processing queued exactly once, only once bytes are confirmed durable
  })

  it('B: a DB row inserted with bytes never uploaded (simulated crash) self-heals on the next retry without a duplicate row', async () => {
    // Row exists from a previous run that crashed between insert and upload —
    // storage_state is still its default 'pending', never touched.
    const crashedRow = {
      id: 'artifact-crashed',
      workspace_id: 'ws-1',
      source_channel: 'whatsapp_operator',
      provider_attachment_id: 'wamid.crashed',
      processing_version: 1,
      storage_state: 'pending',
    }
    const fake = fakeSupabase([crashedRow])
    currentClient = fake.client

    const result = await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.crashed',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.artifact.id).toBe('artifact-crashed') // reused, not duplicated
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].storage_state).toBe('stored')
    expect(fake.insertCalls).toHaveLength(0) // no second insert attempted
    expect(enqueueOperation).toHaveBeenCalledTimes(1)
  })

  it('never claims processing was enqueued for bytes that failed to upload (comment/implementation must agree)', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client
    uploadArtifactBytes.mockResolvedValueOnce({ ok: false, error: 'storage down' })

    await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: null,
    })

    expect(enqueueOperation).not.toHaveBeenCalled()
  })

  it('C: concurrent ingestion for the same provider attachment produces exactly one canonical artifact', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client

    const args = {
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.concurrent',
    }

    const [a, b] = await Promise.all([ingestArtifact(args), ingestArtifact(args)])

    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.artifact.id).toBe(b.artifact.id) // same canonical row, whichever call "won" the insert
    expect(fake.rows).toHaveLength(1) // never two artifacts for one provider attachment
    expect(fake.rows[0].storage_state).toBe('stored')
  })

  it('D: upload succeeds but the DB storage-state patch fails — retry recovers without a duplicate row or duplicate upload attempt', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client
    fake.forceNextStoredPatchFailure()

    const args = {
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.patch-fails-once',
    }

    const first = await ingestArtifact(args)
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error('unreachable')
    expect(first.errorCode).toBe('DB_FAILED')
    // The upload genuinely happened, but the row must NOT claim 'stored'
    // since the DB never actually confirmed it.
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].storage_state).not.toBe('stored')
    expect(enqueueOperation).not.toHaveBeenCalled()

    const second = await ingestArtifact(args)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.artifact.id).toBe(fake.rows[0].id) // same row, not duplicated
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].storage_state).toBe('stored')
    expect(enqueueOperation).toHaveBeenCalledTimes(1)
  })

  it('adversarial scenario 6: bytes stored but the enqueue itself fails — falls back to inline processing rather than leaving the artifact permanently unprocessed', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client
    enqueueOperation.mockResolvedValueOnce({ queued: false, alreadyQueued: false, reason: 'transient DB error' })

    const result = await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.enqueue-fails',
    })

    // Bytes are durably stored regardless — that contract holds even though
    // the queue entry never landed.
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(fake.rows[0].storage_state).toBe('stored')
    // The gap is closed inline rather than left as an orphaned 'stored'
    // row with no path to ever being understood.
    expect(processArtifact).toHaveBeenCalledWith(result.artifact.id)
  })

  it('does not fall back to inline processing when the enqueue succeeds normally', async () => {
    const fake = fakeSupabase([])
    currentClient = fake.client

    await ingestArtifact({
      workspaceId: 'ws-1',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: null,
    })

    expect(processArtifact).not.toHaveBeenCalled()
  })
})
