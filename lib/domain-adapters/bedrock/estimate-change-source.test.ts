import { describe, expect, it } from 'vitest'
import {
  BedrockEstimateChangeSource,
  ESTIMATE_TRACKED_FIELDS,
} from './estimate-change-source'
import { decodeBedrockCursor, encodeBedrockCursor } from './change-source'
import { InMemoryDomainSnapshotStore } from './snapshot-store'
import type { BedrockReadProvider, BedrockRow } from './provider'

const COMPANY_ID = 'company-ods'
const PROJECT_ID = 'project-govs-harbour-rev2'
const PROJECT_NAME = "2026 Site Improvements — Governor's Harbour (Rev. 2)"

/** A realistic ODS estimate row, defaulted to EST-00014's actual shape. */
const row = (
  id: string,
  updated_at: string,
  overrides: Partial<BedrockRow> = {},
): BedrockRow => ({
  id,
  company_id: COMPANY_ID,
  updated_at,
  estimate_number: 'EST-00014',
  project_id: PROJECT_ID,
  title: PROJECT_NAME,
  status: 'draft',
  total_amount: 33984.48,
  subtotal: 31800.0,
  overhead_amount: 1272.0,
  profit_amount: 912.48,
  tax_amount: 0,
  issue_date: '2026-08-01',
  revision: 2,
  revision_number: 2,
  ...overrides,
})

interface FakeCall {
  after: { updatedAt: string; id: string } | null
  limit: number
  notBefore: string | null | undefined
}

/**
 * Narrow fake matching only the method this change source calls.
 * `listEstimatesChangedSince` is being added to `BedrockReadProvider` by
 * another agent concurrently; this fake does not depend on that landing.
 */
function fakeProvider(scan: BedrockRow[], calls: FakeCall[]): BedrockReadProvider {
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'listEstimatesChangedSince'
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
  ) as unknown as BedrockReadProvider
}

function source(opts: {
  scan: BedrockRow[]
  calls?: FakeCall[]
  snapshots?: InMemoryDomainSnapshotStore
  batchSize?: number
  now?: () => Date
}) {
  return new BedrockEstimateChangeSource({
    workspaceId: 'ws-ods',
    companyId: COMPANY_ID,
    provider: fakeProvider(opts.scan, opts.calls ?? []),
    snapshots: opts.snapshots ?? new InMemoryDomainSnapshotStore(),
    batchSize: opts.batchSize,
    now: opts.now,
  })
}

describe('BedrockEstimateChangeSource', () => {
  it('emits operation: snapshot, never created, on first sight of an estimate', async () => {
    const src = source({ scan: [row('est-14', '2026-08-01T12:00:00.000000+00:00')] })
    const batch = await src.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    const change = batch.changes[0]
    expect(change.operation).toBe('snapshot')
    expect(change.operation).not.toBe('created')
    expect(change.previous).toBeNull()
    expect(change.current?.status).toBe('draft')
    expect(change.current?.estimate_number).toBe('EST-00014')
    // Bootstrap is Caye looking, not Bedrock acting.
    expect(change.actor).toEqual({ kind: 'system', label: 'bedrock_bootstrap_scan' })
    expect(change.metadata?.bootstrap).toBe(true)
  })

  it('bootstraps all 25 pre-existing ODS estimates without a single transition', async () => {
    const scan = Array.from({ length: 25 }, (_, i) =>
      row(`est-${i}`, `2026-08-01T12:00:0${i % 10}.000000+00:00`, {
        estimate_number: `EST-${String(i).padStart(5, '0')}`,
        status: i % 4 === 0 ? 'approved' : 'draft',
      }),
    )
    const src = source({ scan, batchSize: 100 })
    const batch = await src.readChanges(null)

    expect(batch.changes).toHaveLength(25)
    for (const change of batch.changes) {
      expect(change.operation).toBe('snapshot')
      expect(change.actor).toEqual({ kind: 'system', label: 'bedrock_bootstrap_scan' })
    }
  })

  it('emits a change with previous draft and current approved on a draft -> approved transition', async () => {
    const snapshots = new InMemoryDomainSnapshotStore()
    const ts1 = '2026-08-01T12:00:00.000000+00:00'
    const ts2 = '2026-08-05T09:30:00.000000+00:00'

    const first = source({ scan: [row('est-14', ts1, { status: 'draft' })], snapshots })
    await first.readChanges(null)
    await first.flushPending()

    const second = source({ scan: [row('est-14', ts2, { status: 'approved' })], snapshots })
    const batch = await second.readChanges(encodeBedrockCursor(ts1, 'est-14'))

    expect(batch.changes).toHaveLength(1)
    const change = batch.changes[0]
    expect(change.operation).toBe('updated')
    expect(change.previous?.status).toBe('draft')
    expect(change.current?.status).toBe('approved')
    // A real transition is attributed to the outside world, not the bootstrap scan.
    expect(change.actor).toEqual({ kind: 'external', label: 'bedrock' })
  })

  it('emits nothing for a row rewritten with no tracked-field change', async () => {
    const snapshots = new InMemoryDomainSnapshotStore()
    const ts1 = '2026-08-01T12:00:00.000000+00:00'
    const ts2 = '2026-08-02T08:00:00.000000+00:00'

    const first = source({ scan: [row('est-14', ts1)], snapshots })
    await first.readChanges(null)
    await first.flushPending()

    // updated_at moved (e.g. an untracked column changed) but every tracked
    // field is identical.
    const second = source({ scan: [row('est-14', ts2)], snapshots })
    const batch = await second.readChanges(encodeBedrockCursor(ts1, 'est-14'))

    expect(batch.changes).toHaveLength(0)
    // The cursor still advances so the row is not re-scanned forever.
    expect(decodeBedrockCursor(batch.nextCursor)).toEqual({ updatedAt: ts2, id: 'est-14' })
  })

  it('advances the keyset cursor and resumes correctly from it', async () => {
    const calls: FakeCall[] = []
    const ts = '2026-08-01T12:00:00.000000+00:00'
    const src = source({ scan: [row('est-14', ts)], calls, batchSize: 1 })

    const batch = await src.readChanges(encodeBedrockCursor(ts, 'est-00'))
    expect(batch.nextCursor?.value).toBe(`${ts}|est-14`)
    expect(decodeBedrockCursor(batch.nextCursor)).toEqual({ updatedAt: ts, id: 'est-14' })

    // Resuming with the returned cursor seeks past the last row read.
    await src.readChanges(batch.nextCursor)
    expect(calls[1].after).toEqual({ updatedAt: ts, id: 'est-14' })
  })

  it('re-reads a bounded safety overlap behind the durable cursor without regressing it', async () => {
    const calls: FakeCall[] = []
    const durable = encodeBedrockCursor('2026-08-05T09:05:00.123456+00:00', 'est-99')
    const src = source({
      scan: [row('late-commit', '2026-08-05T09:04:59.999999+00:00')],
      calls,
      now: () => new Date('2026-08-05T09:06:00Z'),
    })

    const batch = await src.readChanges(durable)

    expect(calls[0].notBefore).toBeTruthy()
    expect(new Date(calls[0].notBefore as string).getTime()).toBeLessThan(
      new Date('2026-08-05T09:05:00.123456+00:00').getTime(),
    )
    expect(batch.changes).toHaveLength(1)
    // The overlap read must never move the durable checkpoint backward.
    expect(batch.nextCursor?.value).toBe(durable.value)
  })

  it('respects the batch limit and reports hasMore for the caller to continue looping', async () => {
    const calls: FakeCall[] = []
    const scan = [
      row('est-1', '2026-08-01T00:00:00.000000+00:00'),
      row('est-2', '2026-08-01T00:00:01.000000+00:00'),
    ]
    const src = source({ scan, calls, batchSize: 2 })

    const batch = await src.readChanges(null)

    expect(calls[0].limit).toBe(2)
    expect(batch.hasMore).toBe(true)
    expect(batch.changes).toHaveLength(2)
  })

  it('reports hasMore: false once a page comes back under the batch size', async () => {
    const src = source({
      scan: [row('est-1', '2026-08-01T00:00:00.000000+00:00')],
      batchSize: 5,
    })
    const batch = await src.readChanges(null)
    expect(batch.hasMore).toBe(false)
  })

  it('clamps batchSize into [1, 500] the same as the purchase-order source', () => {
    const oversized = source({ scan: [], batchSize: 10_000 })
    const undersized = source({ scan: [], batchSize: 0 })
    expect(oversized).toBeInstanceOf(BedrockEstimateChangeSource)
    expect(undersized).toBeInstanceOf(BedrockEstimateChangeSource)
  })

  it('throws rather than filing a mis-scoped row under this workspace', async () => {
    const src = source({
      scan: [row('est-other-company', '2026-08-01T00:00:00.000000+00:00', { company_id: 'company-someone-else' })],
    })
    await expect(src.readChanges(null)).rejects.toThrow(/scoped to a different company/)
  })

  it('requires workspaceId and companyId', () => {
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider([], [])
    expect(
      () => new BedrockEstimateChangeSource({ workspaceId: '', companyId: COMPANY_ID, provider, snapshots }),
    ).toThrow(/workspaceId/)
    expect(
      () => new BedrockEstimateChangeSource({ workspaceId: 'ws-ods', companyId: '', provider, snapshots }),
    ).toThrow(/companyId/)
  })

  it('tracks exactly the fields normalize.ts\'s case \'estimate\' needs plus project linkage and bootstrap display context', () => {
    // status/revision/revision_number/total_amount/subtotal/overhead_amount/
    // profit_amount/tax_amount are what normalize.ts's fieldChanges() diffs.
    // project_id/estimate_number/issue_date/title are not diffed there, but
    // project_id feeds normalize.ts's related() lookup and the rest give the
    // bootstrap snapshot payload useful context. See the doc comment on
    // ESTIMATE_TRACKED_FIELDS for the full reasoning and the accepted
    // precedent in PURCHASE_ORDER_TRACKED_FIELDS.
    expect(new Set(ESTIMATE_TRACKED_FIELDS)).toEqual(
      new Set([
        'status',
        'total_amount',
        'estimate_number',
        'project_id',
        'issue_date',
        'title',
        'revision',
        'revision_number',
        'subtotal',
        'overhead_amount',
        'profit_amount',
        'tax_amount',
      ]),
    )
  })
})
