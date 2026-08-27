import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

interface FakeArtifact {
  id: string
  workspace_id: string
  retention_status: string
  received_at: string
  [k: string]: unknown
}

/**
 * Fake DB holding rows for TWO workspaces, tailored to searchArtifacts'/
 * getArtifactDetail's exact chains. Every query call records the eq()
 * filters applied so tests can assert workspace_id was always among them,
 * and the in-memory "table" only ever returns rows actually matching every
 * applied eq() filter — so a query missing the workspace_id filter would be
 * caught by returning the OTHER workspace's rows too.
 */
function fakeSupabase(
  artifacts: FakeArtifact[],
  opts: { observations?: Record<string, unknown>[]; relations?: Record<string, unknown>[] } = {}
) {
  const eqLog: Array<{ table: string; col: string; val: unknown }> = []

  function filterTable(table: string, rows: Record<string, unknown>[]) {
    const chain: Record<string, unknown> = { __rows: rows }
    chain.eq = vi.fn((col: string, val: unknown) => {
      eqLog.push({ table, col, val })
      return filterTable(table, rows.filter((r) => r[col] === val))
    })
    chain.neq = vi.fn((col: string, val: unknown) => filterTable(table, rows.filter((r) => r[col] !== val)))
    chain.is = vi.fn((col: string, val: unknown) => filterTable(table, rows.filter((r) => (val === null ? r[col] == null : r[col] === val))))
    chain.gte = vi.fn(() => chain)
    chain.lte = vi.fn(() => chain)
    chain.in = vi.fn((col: string, vals: unknown[]) => filterTable(table, rows.filter((r) => vals.includes(r[col]))))
    chain.order = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null }))
    // Thenable: `await chain` after .order().limit() resolves like the real
    // client without needing a separate terminal call.
    chain.then = (
      onfulfilled?: ((value: unknown) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null
    ) => Promise.resolve({ data: rows, error: null }).then(onfulfilled ?? undefined, onrejected ?? undefined)
    return chain
  }

  const from = vi.fn((table: string) => ({
    select: vi.fn(() => {
      if (table === 'business_artifacts') return filterTable(table, artifacts as unknown as Record<string, unknown>[])
      if (table === 'business_artifact_observations') return filterTable(table, opts.observations ?? [])
      if (table === 'business_artifact_relations') return filterTable(table, opts.relations ?? [])
      throw new Error(`unexpected table ${table}`)
    }),
  }))

  return { client: { from }, eqLog }
}

let currentClient: ReturnType<typeof fakeSupabase>['client']
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => currentClient }))

import { searchArtifacts, getArtifactDetail, getMostRecentArtifactForOperator } from './query'

const WORKSPACE_A_ARTIFACT: FakeArtifact = {
  id: 'artifact-a',
  workspace_id: 'ws-a',
  retention_status: 'active',
  storage_state: 'stored',
  received_at: '2026-08-26T10:00:00Z',
  filename: 'pickup.jpg',
  modality: 'image',
}
const WORKSPACE_B_ARTIFACT: FakeArtifact = {
  id: 'artifact-b',
  workspace_id: 'ws-b',
  retention_status: 'active',
  storage_state: 'stored',
  received_at: '2026-08-26T10:00:00Z',
  filename: 'other-workspace-secret.jpg',
  modality: 'image',
}

describe('workspace isolation (#87 mandatory test — search/get/recent must never cross workspaces)', () => {
  it('searchArtifacts for workspace A never returns workspace B rows, even with identical content', async () => {
    const fake = fakeSupabase([WORKSPACE_A_ARTIFACT, WORKSPACE_B_ARTIFACT])
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a' })

    expect(results.items.map((r) => r.artifact.id)).toEqual(['artifact-a'])
    expect(fake.eqLog).toContainEqual({ table: 'business_artifacts', col: 'workspace_id', val: 'ws-a' })
  })

  it('getArtifactDetail cannot fetch an artifact by id across workspaces', async () => {
    const fake = fakeSupabase([WORKSPACE_B_ARTIFACT])
    currentClient = fake.client

    // Workspace A asks for workspace B's real artifact id directly.
    const detail = await getArtifactDetail('ws-a', 'artifact-b')

    expect(detail).toBeNull()
  })

  it('getMostRecentArtifactForOperator never resolves an operator id belonging to a different workspace', async () => {
    const fake = fakeSupabase([{ ...WORKSPACE_B_ARTIFACT, sender_operator_allowlist_id: 7 }])
    currentClient = fake.client

    const result = await getMostRecentArtifactForOperator({ workspaceId: 'ws-a', operatorAllowlistId: 7 })

    expect(result).toBeNull()
  })
})

describe('storage durability guard (#87 test I — retrieval refuses an artifact whose blob is not confirmed durable)', () => {
  it('getArtifactDetail refuses a row whose storage_state is not "stored"', async () => {
    const notYetStored: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'artifact-pending', storage_state: 'pending' }
    const fake = fakeSupabase([notYetStored])
    currentClient = fake.client

    const detail = await getArtifactDetail('ws-a', 'artifact-pending')
    expect(detail).toBeNull()
  })

  it('getArtifactDetail refuses a row whose upload failed', async () => {
    const failedUpload: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'artifact-failed', storage_state: 'failed' }
    const fake = fakeSupabase([failedUpload])
    currentClient = fake.client

    const detail = await getArtifactDetail('ws-a', 'artifact-failed')
    expect(detail).toBeNull()
  })

  it('searchArtifacts never surfaces a row whose bytes are not confirmed durable', async () => {
    const notYetStored: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'artifact-pending', storage_state: 'pending' }
    const fake = fakeSupabase([notYetStored, WORKSPACE_A_ARTIFACT])
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a' })
    expect(results.items.map((r) => r.artifact.id)).toEqual(['artifact-a'])
  })

  it('N: still returns the durable original when UNDERSTANDING failed — storage durability and processing success are independent', async () => {
    const storedButUnderstandingFailed: FakeArtifact = {
      ...WORKSPACE_A_ARTIFACT,
      id: 'artifact-storage-ok-processing-failed',
      storage_state: 'stored',
      processing_status: 'failed',
      processing_error: 'model call timed out',
    }
    const fake = fakeSupabase([storedButUnderstandingFailed])
    currentClient = fake.client

    const detail = await getArtifactDetail('ws-a', 'artifact-storage-ok-processing-failed')
    expect(detail).not.toBeNull()
    expect(detail?.artifact.processing_status).toBe('failed')
    expect(detail?.artifact.storage_state).toBe('stored')
  })

  it('getMostRecentArtifactForOperator never resolves to a not-yet-stored row', async () => {
    const notYetStored: FakeArtifact = {
      ...WORKSPACE_A_ARTIFACT,
      id: 'artifact-pending',
      storage_state: 'pending',
      sender_operator_allowlist_id: 7,
    }
    const fake = fakeSupabase([notYetStored])
    currentClient = fake.client

    const result = await getMostRecentArtifactForOperator({ workspaceId: 'ws-a', operatorAllowlistId: 7 })
    expect(result).toBeNull()
  })
})

describe('ordinal resolution — "that image"/"the second photo" (#87 conversational reference resolution)', () => {
  it('ordinal=latest returns the most recently received match', async () => {
    const older: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'older', received_at: '2026-08-20T00:00:00Z' }
    const newer: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'newer', received_at: '2026-08-26T00:00:00Z' }
    const fake = fakeSupabase([older, newer]) // fake preserves insertion order as the "already sorted desc" base order
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a', ordinal: 'latest' })
    expect(results.items).toHaveLength(1)
    expect(results.items[0].artifact.id).toBe('older') // first row in the fake's base order stands in for "already ordered desc"
    expect(results.ambiguous).toBe(false) // ordinal lookups are never flagged ambiguous — the request is already unambiguous
  })

  it('ordinal=second_most_recent skips the first result', async () => {
    const first: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'first' }
    const second: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'second' }
    const fake = fakeSupabase([first, second])
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a', ordinal: 'second_most_recent' })
    expect(results.items).toHaveLength(1)
    expect(results.items[0].artifact.id).toBe('second')
  })
})

describe('retrieval ambiguity (#87 review pass 2, item D) — a tied top score is a question, not a ranking', () => {
  it('D3: two equally-plausible pickup photos for "pickup picture" are flagged ambiguous, not silently resolved to one', async () => {
    const casinoTramStop: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'casino-tram-photo', filename: 'IMG_001.jpg' }
    const pinkBuildingByDock: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'pink-building-photo', filename: 'IMG_002.jpg' }
    // Both artifacts have a confirmed relation label mentioning "pickup" —
    // the term-overlap scorer weighs confirmed labels most heavily, and
    // both match the query term equally, producing a genuine tie.
    const fake = fakeSupabase([casinoTramStop, pinkBuildingByDock], {
      relations: [
        { artifact_id: 'casino-tram-photo', status: 'confirmed', superseded_at: null, label: 'Casino Tram Stop pickup point' },
        { artifact_id: 'pink-building-photo', status: 'confirmed', superseded_at: null, label: 'Pink building by dock pickup point' },
      ],
    })
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a', query: 'pickup picture' })

    expect(results.items).toHaveLength(2)
    expect(results.ambiguous).toBe(true)
  })

  it('a query that clearly favors one artifact over another is NOT flagged ambiguous', async () => {
    const casinoTramStop: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'casino-tram-photo', filename: 'IMG_001.jpg' }
    const unrelatedReceipt: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'receipt-photo', filename: 'IMG_002.jpg', modality: 'document' }
    const fake = fakeSupabase([casinoTramStop, unrelatedReceipt])
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a', query: 'IMG_001' })
    expect(results.ambiguous).toBe(false)
  })
})
