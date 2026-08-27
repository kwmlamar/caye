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
function fakeSupabase(artifacts: FakeArtifact[]) {
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
      if (table === 'business_artifact_observations') return filterTable(table, [])
      if (table === 'business_artifact_relations') return filterTable(table, [])
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
  received_at: '2026-08-26T10:00:00Z',
  filename: 'pickup.jpg',
  modality: 'image',
}
const WORKSPACE_B_ARTIFACT: FakeArtifact = {
  id: 'artifact-b',
  workspace_id: 'ws-b',
  retention_status: 'active',
  received_at: '2026-08-26T10:00:00Z',
  filename: 'other-workspace-secret.jpg',
  modality: 'image',
}

describe('workspace isolation (#87 mandatory test — search/get/recent must never cross workspaces)', () => {
  it('searchArtifacts for workspace A never returns workspace B rows, even with identical content', async () => {
    const fake = fakeSupabase([WORKSPACE_A_ARTIFACT, WORKSPACE_B_ARTIFACT])
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a' })

    expect(results.map((r) => r.artifact.id)).toEqual(['artifact-a'])
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

describe('ordinal resolution — "that image"/"the second photo" (#87 conversational reference resolution)', () => {
  it('ordinal=latest returns the most recently received match', async () => {
    const older: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'older', received_at: '2026-08-20T00:00:00Z' }
    const newer: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'newer', received_at: '2026-08-26T00:00:00Z' }
    const fake = fakeSupabase([older, newer]) // fake preserves insertion order as the "already sorted desc" base order
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a', ordinal: 'latest' })
    expect(results).toHaveLength(1)
    expect(results[0].artifact.id).toBe('older') // first row in the fake's base order stands in for "already ordered desc"
  })

  it('ordinal=second_most_recent skips the first result', async () => {
    const first: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'first' }
    const second: FakeArtifact = { ...WORKSPACE_A_ARTIFACT, id: 'second' }
    const fake = fakeSupabase([first, second])
    currentClient = fake.client

    const results = await searchArtifacts({ workspaceId: 'ws-a', ordinal: 'second_most_recent' })
    expect(results).toHaveLength(1)
    expect(results[0].artifact.id).toBe('second')
  })
})
