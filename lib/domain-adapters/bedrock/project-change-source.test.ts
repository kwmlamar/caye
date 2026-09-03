import { describe, expect, it } from 'vitest'
import { BedrockProjectChangeSource, PROJECT_TRACKED_FIELDS } from './project-change-source'
import { decodeBedrockCursor, encodeBedrockCursor } from './change-source'
import { InMemoryDomainSnapshotStore } from './snapshot-store'
import type { BedrockReadProvider, BedrockRow } from './provider'

const COMPANY_ID = 'company-abaco-1'
const WORKSPACE_ID = 'ws-1'

function project(
  id: string,
  updated_at: string,
  overrides: Partial<BedrockRow> = {},
): BedrockRow {
  return {
    id,
    company_id: COMPANY_ID,
    updated_at,
    name: 'Blue Sky Villa — Great Room Flooring',
    status: 'active',
    start_date: '2026-02-03',
    estimated_end_date: '2026-05-15',
    actual_end_date: null,
    client_id: 'client-blue-sky',
    contract_value: 184500,
    budget: 162000,
    ...overrides,
  }
}

/** A narrow fake provider exposing only the method this change source calls. */
function fakeProvider(
  scan: BedrockRow[],
  calls: Array<{ after: unknown; limit: number; notBefore?: string | null }> = [],
): BedrockReadProvider {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'listProjectsChangedSince'
          ? async (
              _companyId: string,
              after: { updatedAt: string; id: string } | null,
              limit: number,
              notBefore?: string | null,
            ) => {
              calls.push({ after, limit, notBefore })
              return scan
            }
          : async () => null,
    },
  ) as BedrockReadProvider
}

describe('BedrockProjectChangeSource', () => {
  it('exposes the DomainChangeSource contract', () => {
    const source = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([]),
      snapshots: new InMemoryDomainSnapshotStore(),
    })
    expect(source.sourceSystem).toBe('bedrock')
    expect(source.sourceCompanyId).toBe(COMPANY_ID)
    expect(source.stream).toBe('projects')
  })

  it('emits first sight as a snapshot, never created or a transition', async () => {
    const ts = '2026-01-10T09:00:00.000000+00:00'
    const source = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([project('proj-1', ts, { status: 'active' })]),
      snapshots: new InMemoryDomainSnapshotStore(),
    })

    const batch = await source.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    const change = batch.changes[0]!
    expect(change.operation).toBe('snapshot')
    expect(change.previous).toBeNull()
    expect(change.current?.status).toBe('active')
    expect(change.sourceEntityType).toBe('project')
    expect(change.actor).toEqual({ kind: 'system', label: 'bedrock_bootstrap_scan' })
    expect(change.metadata?.bootstrap).toBe(true)
  })

  it('emits nothing for a row that was merely touched, not changed', async () => {
    const snapshots = new InMemoryDomainSnapshotStore()
    const tsFirst = '2026-01-10T09:00:00.000000+00:00'
    const row = project('proj-2', tsFirst, { status: 'planning' })

    const first = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([row]),
      snapshots,
    })
    const firstBatch = await first.readChanges(null)
    expect(firstBatch.changes).toHaveLength(1)
    await first.flushPending()

    // Same tracked fields, but updated_at moved — e.g. an internal touch that
    // Caye does not care about.
    const tsSecond = '2026-01-10T10:00:00.000000+00:00'
    const touchedRow = { ...row, updated_at: tsSecond }
    const second = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([touchedRow]),
      snapshots,
    })
    const secondBatch = await second.readChanges(encodeBedrockCursor(tsFirst, 'proj-2'))
    expect(secondBatch.changes).toHaveLength(0)
  })

  it('emits a status transition with correct previous/current on a real change', async () => {
    const snapshots = new InMemoryDomainSnapshotStore()
    const tsFirst = '2026-01-10T09:00:00.000000+00:00'
    const row = project('proj-3', tsFirst, { status: 'planning' })

    const first = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([row]),
      snapshots,
    })
    await first.readChanges(null)
    await first.flushPending()

    const tsSecond = '2026-02-01T09:00:00.000000+00:00'
    const changedRow = { ...row, updated_at: tsSecond, status: 'active' }
    const second = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([changedRow]),
      snapshots,
    })
    const batch = await second.readChanges(encodeBedrockCursor(tsFirst, 'proj-3'))

    expect(batch.changes).toHaveLength(1)
    const change = batch.changes[0]!
    expect(change.operation).toBe('updated')
    expect(change.previous?.status).toBe('planning')
    expect(change.current?.status).toBe('active')
    expect(change.actor).toEqual({ kind: 'external', label: 'bedrock' })
  })

  it('advances the keyset cursor and resumes correctly', async () => {
    const ts = '2026-01-10T09:00:00.000000+00:00'
    const calls: Array<{ after: unknown; limit: number; notBefore?: string | null }> = []
    const source = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([project('proj-4', ts)], calls),
      snapshots: new InMemoryDomainSnapshotStore(),
      batchSize: 1,
    })

    const batch = await source.readChanges(null)
    expect(batch.nextCursor?.value).toBe(`${ts}|proj-4`)
    expect(decodeBedrockCursor(batch.nextCursor)).toEqual({ updatedAt: ts, id: 'proj-4' })
    expect(batch.hasMore).toBe(true)

    // Resuming with the returned cursor re-queries from just behind it (the
    // safety overlap), then seeks page-locally from there — mirroring
    // BedrockPurchaseOrderChangeSource. The first call of a fresh scan passes
    // `after: null` and relies on `notBefore` for the durable floor.
    const resumeCalls: Array<{ after: unknown; limit: number; notBefore?: string | null }> = []
    const resumed = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([], resumeCalls),
      snapshots: new InMemoryDomainSnapshotStore(),
    })
    const resumedBatch = await resumed.readChanges(batch.nextCursor)
    expect(resumeCalls[0]?.after).toBeNull()
    expect(resumeCalls[0]?.notBefore).toBeTruthy()
    expect(new Date(resumeCalls[0]!.notBefore as string).getTime()).toBeLessThanOrEqual(
      new Date(ts).getTime(),
    )
    expect(resumedBatch.changes).toHaveLength(0)
    expect(resumedBatch.hasMore).toBe(false)
  })

  it('re-reads a bounded safety overlap behind the durable cursor without regressing it', async () => {
    const calls: Array<{ after: unknown; limit: number; notBefore?: string | null }> = []
    const durable = encodeBedrockCursor('2026-01-10T19:05:00.123456+00:00', 'proj-z')
    const source = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider(
        [project('late-commit', '2026-01-10T19:04:59.999999+00:00', { status: 'active' })],
        calls,
      ),
      snapshots: new InMemoryDomainSnapshotStore(),
      now: () => new Date('2026-01-10T19:06:00Z'),
    })

    const batch = await source.readChanges(durable)

    expect(calls[0]?.notBefore).toBeTruthy()
    expect(new Date(calls[0]!.notBefore as string).getTime()).toBeLessThan(
      new Date('2026-01-10T19:05:00.123456+00:00').getTime(),
    )
    expect(batch.changes).toHaveLength(1)
    // The overlap-read row is behind the durable floor, so the durable cursor
    // must not regress even though the scan walked behind it.
    expect(batch.nextCursor?.value).toBe(durable.value)
  })

  it('respects the batch limit passed to the provider', async () => {
    const calls: Array<{ after: unknown; limit: number; notBefore?: string | null }> = []
    const rows = [
      project('proj-a', '2026-01-01T00:00:00.000000+00:00'),
      project('proj-b', '2026-01-02T00:00:00.000000+00:00'),
    ]
    const source = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider(rows, calls),
      snapshots: new InMemoryDomainSnapshotStore(),
      batchSize: 2,
    })

    const batch = await source.readChanges(null)
    expect(calls[0]?.limit).toBe(2)
    // Two rows returned for a batch size of 2 means the scan must continue.
    expect(batch.hasMore).toBe(true)
  })

  it('clamps an out-of-range batchSize into [1, 500]', async () => {
    const calls: Array<{ after: unknown; limit: number; notBefore?: string | null }> = []
    const source = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([], calls),
      snapshots: new InMemoryDomainSnapshotStore(),
      batchSize: 10000,
    })
    await source.readChanges(null)
    expect(calls[0]?.limit).toBe(500)
  })

  it('throws when a returned row belongs to a different company', async () => {
    const source = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([
        project('proj-mis-scoped', '2026-01-01T00:00:00.000000+00:00', {
          company_id: 'some-other-company',
        }),
      ]),
      snapshots: new InMemoryDomainSnapshotStore(),
    })
    await expect(source.readChanges(null)).rejects.toThrow(/different company/)
  })

  it('tracks the fields the task specifies at minimum', () => {
    for (const field of [
      'status',
      'start_date',
      'estimated_end_date',
      'actual_end_date',
      'name',
      'client_id',
      'contract_value',
      'budget',
    ]) {
      expect(PROJECT_TRACKED_FIELDS).toContain(field)
    }
  })

  it('uses realistic ODS project fixtures across the project lifecycle', async () => {
    const snapshots = new InMemoryDomainSnapshotStore()
    const tsFirst = '2026-01-05T08:00:00.000000+00:00'
    const row = project('proj-governors-harbour', tsFirst, {
      name: "2026 Site Improvements — Governor's Harbour (Rev. 2)",
      status: 'planning',
    })
    const first = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([row]),
      snapshots,
    })
    const firstBatch = await first.readChanges(null)
    expect(firstBatch.changes[0]?.operation).toBe('snapshot')
    await first.flushPending()

    const tsSecond = '2026-03-01T08:00:00.000000+00:00'
    const completed = {
      ...row,
      updated_at: tsSecond,
      status: 'completed',
      actual_end_date: '2026-02-28',
    }
    const second = new BedrockProjectChangeSource({
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      provider: fakeProvider([completed]),
      snapshots,
    })
    const batch = await second.readChanges(encodeBedrockCursor(tsFirst, 'proj-governors-harbour'))
    expect(batch.changes).toHaveLength(1)
    expect(batch.changes[0]?.previous?.status).toBe('planning')
    expect(batch.changes[0]?.current?.status).toBe('completed')
    expect(batch.changes[0]?.current?.actual_end_date).toBe('2026-02-28')
  })
})
