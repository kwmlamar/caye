import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const enqueueOperation = vi.hoisted(() => vi.fn().mockResolvedValue({ queued: true, alreadyQueued: false }))
vi.mock('@/lib/pending-operations', () => ({ enqueueOperation }))

const uploadArtifactBytes = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }))
vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return { ...actual, uploadArtifactBytes }
})

/**
 * Minimal thenable query-builder fake tailored to ingest.ts's exact chains:
 *   dedup:  .from('business_artifacts').select('*').eq().eq().eq().maybeSingle()
 *   insert: .from('business_artifacts').insert(payload).select('*').single()
 *   patch:  .from('business_artifacts').update(payload).eq('id', id)
 */
function fakeSupabase(opts: {
  dedupResult?: { data: unknown; error?: unknown }
  insertResult?: { data: unknown; error?: { code?: string; message: string } | null }
}) {
  const eqCalls: Array<[string, unknown]> = []
  const insertCalls: unknown[] = []
  const updateCalls: unknown[] = []

  const from = vi.fn((table: string) => {
    if (table !== 'business_artifacts') throw new Error(`unexpected table ${table}`)
    return {
      select: vi.fn(() => {
        const chain: Record<string, unknown> = {}
        chain.eq = vi.fn((col: string, val: unknown) => {
          eqCalls.push([col, val])
          return chain
        })
        chain.maybeSingle = vi.fn(() => Promise.resolve(opts.dedupResult ?? { data: null, error: null }))
        return chain
      }),
      insert: vi.fn((payload: unknown) => {
        insertCalls.push(payload)
        return {
          select: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve(opts.insertResult ?? { data: null, error: { message: 'no insertResult configured' } })),
          })),
        }
      }),
      update: vi.fn((payload: unknown) => {
        updateCalls.push(payload)
        return { eq: vi.fn(() => Promise.resolve({ error: null })) }
      }),
    }
  })

  return { client: { from }, eqCalls, insertCalls, updateCalls }
}

let currentClient: ReturnType<typeof fakeSupabase>['client']
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => currentClient }))

import { ingestArtifact } from './ingest'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

beforeEach(() => {
  enqueueOperation.mockClear()
  uploadArtifactBytes.mockClear().mockResolvedValue({ ok: true })
})

describe('ingestArtifact — idempotent ingestion (#87 acceptance test 1)', () => {
  it('returns the SAME artifact for a duplicate provider_attachment_id instead of creating a second one', async () => {
    const existing = { id: 'artifact-existing', workspace_id: 'ws-1', processing_version: 1 }
    const fake = fakeSupabase({ dedupResult: { data: existing } })
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
    // No new row was inserted, no bytes re-uploaded, no duplicate job enqueued.
    expect(fake.insertCalls).toHaveLength(0)
    expect(uploadArtifactBytes).not.toHaveBeenCalled()
    expect(enqueueOperation).not.toHaveBeenCalled()
  })

  it('scopes the dedup lookup by workspace_id, source_channel, AND provider_attachment_id — never cross-workspace (acceptance test 2)', async () => {
    const fake = fakeSupabase({
      dedupResult: { data: null }, // workspace-2's lookup must not see workspace-1's row
      insertResult: { data: { id: 'artifact-new', workspace_id: 'ws-2', processing_version: 1 }, error: null },
    })
    currentClient = fake.client

    await ingestArtifact({
      workspaceId: 'ws-2',
      sourceChannel: 'whatsapp_operator',
      bytes: PNG_BYTES,
      declaredMimeType: 'image/png',
      filename: null,
      providerAttachmentId: 'wamid.same-attachment', // same provider id as workspace-1's artifact
    })

    expect(fake.eqCalls).toContainEqual(['workspace_id', 'ws-2'])
    expect(fake.eqCalls).toContainEqual(['source_channel', 'whatsapp_operator'])
    expect(fake.eqCalls).toContainEqual(['provider_attachment_id', 'wamid.same-attachment'])
    // A genuinely new artifact was created for workspace-2 — the dedup path
    // never silently reused workspace-1's row across the tenant boundary.
    expect(fake.insertCalls).toHaveLength(1)
  })

  it('rejects an oversized file before ever touching storage or the database', async () => {
    const fake = fakeSupabase({})
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
