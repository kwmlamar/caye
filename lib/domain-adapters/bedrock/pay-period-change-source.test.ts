import { describe, expect, it } from 'vitest'

import {
  BedrockPayPeriodChangeSource,
  PAY_PERIOD_TRACKED_FIELDS,
} from './pay-period-change-source'
import { InMemoryDomainSnapshotStore } from './snapshot-store'
import type { BedrockReadProvider, BedrockRow } from './provider'

/**
 * Narrow fake: the change source only ever calls `listAllPayPeriods`, so the
 * fake implements just that and is cast to the full provider interface, the
 * same pattern `receipt-change-source.test.ts` uses for receipts.
 */
type FakePayPeriodProvider = Pick<BedrockReadProvider, 'listAllPayPeriods'>

function payPeriodRow(id: string, overrides: Partial<BedrockRow> = {}): BedrockRow {
  return {
    id,
    company_id: 'company-1',
    start_date: '2026-08-08',
    end_date: '2026-08-21',
    status: 'open',
    processed_at: null,
    voided_at: null,
    void_reason: null,
    reopened_at: null,
    reopen_reason: null,
    created_at: '2026-08-08T10:00:00Z',
    ...overrides,
  }
}

function fakeProvider(
  state: { rows: BedrockRow[] },
  calls: Array<{ companyId: string; limit: number }> = [],
): BedrockReadProvider {
  const fake: FakePayPeriodProvider = {
    listAllPayPeriods: async (companyId: string, limit: number) => {
      calls.push({ companyId, limit })
      // Mirrors what a real bounded query would do: never return more than
      // `limit` rows, regardless of how many the "table" holds.
      return state.rows.slice(0, limit)
    },
  }
  return fake as BedrockReadProvider
}

function source(
  provider: BedrockReadProvider,
  snapshots: InMemoryDomainSnapshotStore,
  overrides: Partial<{ workspaceId: string; companyId: string; batchSize: number; now: () => Date }> = {},
) {
  return new BedrockPayPeriodChangeSource({
    workspaceId: overrides.workspaceId ?? 'ws-1',
    companyId: overrides.companyId ?? 'company-1',
    provider,
    snapshots,
    batchSize: overrides.batchSize,
    now: overrides.now,
  })
}

describe('BedrockPayPeriodChangeSource', () => {
  it('tracks exactly the fields normalize.ts inspects for pay periods, plus the descriptive minimum', () => {
    expect(PAY_PERIOD_TRACKED_FIELDS).toEqual(
      expect.arrayContaining([
        'status',
        'processed_at',
        'voided_at',
        'void_reason',
        'reopened_at',
        'reopen_reason',
        'start_date',
        'end_date',
      ]),
    )
  })

  it('first sight emits snapshot, never a transition', async () => {
    const state = { rows: [payPeriodRow('pp1', { status: 'paid', processed_at: '2026-07-01T00:00:00Z' })] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const first = source(fakeProvider(state), snapshots)

    const batch = await first.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    expect(batch.changes[0].operation).toBe('snapshot')
    expect(batch.changes[0].previous).toBeNull()
    expect(batch.changes[0].current).toMatchObject({ status: 'paid' })
    // Bootstrap is Caye looking, not Bedrock acting.
    expect(batch.changes[0].actor).toMatchObject({ kind: 'system' })
  })

  it('bootstraps a 35-row ODS-scale batch, 22 already paid, without misclassifying any as a transition', async () => {
    const rows: BedrockRow[] = []
    for (let i = 0; i < 35; i++) {
      const paid = i < 22
      rows.push(
        payPeriodRow(`pp-ods-${i}`, {
          status: paid ? 'paid' : 'open',
          processed_at: paid ? `2026-0${(i % 6) + 1}-01T00:00:00Z` : null,
        }),
      )
    }
    const state = { rows }
    const snapshots = new InMemoryDomainSnapshotStore()
    const first = source(fakeProvider(state), snapshots, { batchSize: 500 })

    const batch = await first.readChanges(null)

    expect(batch.changes).toHaveLength(35)
    expect(batch.changes.every((change) => change.operation === 'snapshot')).toBe(true)
    expect(batch.changes.every((change) => change.actor?.kind === 'system')).toBe(true)
  })

  it('detects an open -> processing transition even though no timestamp moved', async () => {
    const state = { rows: [payPeriodRow('pp2', { status: 'open' })] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider(state)

    const bootstrap = source(provider, snapshots)
    expect((await bootstrap.readChanges(null)).changes).toHaveLength(1)
    await bootstrap.flushPending()

    // Only status flips. There is no updated_at at all on this table, and
    // processed_at has not been set yet either — this is exactly the case
    // the fingerprint mechanism exists for.
    state.rows = [{ ...state.rows[0], status: 'processing' }]

    const replay = source(provider, snapshots)
    const batch = await replay.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    expect(batch.changes[0].operation).toBe('updated')
    expect(batch.changes[0].previous).toMatchObject({ status: 'open' })
    expect(batch.changes[0].current).toMatchObject({ status: 'processing' })
    expect(batch.changes[0].actor).toMatchObject({ kind: 'external', label: 'bedrock' })
  })

  it('detects a processing -> paid transition', async () => {
    const state = {
      rows: [payPeriodRow('pp3', { status: 'processing', processed_at: '2026-08-22T09:00:00Z' })],
    }
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider(state)

    const bootstrap = source(provider, snapshots)
    expect((await bootstrap.readChanges(null)).changes).toHaveLength(1)
    await bootstrap.flushPending()

    state.rows = [{ ...state.rows[0], status: 'paid' }]

    const replay = source(provider, snapshots)
    const batch = await replay.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    expect(batch.changes[0].operation).toBe('updated')
    expect(batch.changes[0].previous).toMatchObject({ status: 'processing' })
    expect(batch.changes[0].current).toMatchObject({ status: 'paid' })
  })

  it('emits nothing for an unchanged row on a repeat scan', async () => {
    const state = { rows: [payPeriodRow('pp4')] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider(state)

    const bootstrap = source(provider, snapshots)
    expect((await bootstrap.readChanges(null)).changes).toHaveLength(1)
    await bootstrap.flushPending()

    const replay = source(provider, snapshots)
    const batch = await replay.readChanges(null)

    expect(batch.changes).toHaveLength(0)
    expect(batch.hasMore).toBe(false)
  })

  it('respects the scan limit', async () => {
    const state = {
      rows: [payPeriodRow('pp5'), payPeriodRow('pp6'), payPeriodRow('pp7')],
    }
    const snapshots = new InMemoryDomainSnapshotStore()
    const calls: Array<{ companyId: string; limit: number }> = []
    const provider = fakeProvider(state, calls)

    const bounded = source(provider, snapshots, { batchSize: 2 })
    const batch = await bounded.readChanges(null)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(2)
    expect(batch.changes).toHaveLength(2)
    // No offset parameter exists on listAllPayPeriods, so there is no
    // further page behind this bounded read.
    expect(batch.hasMore).toBe(false)
  })

  it('does not emit anything, and does not throw, for a pay period that disappeared from the scan', async () => {
    const state = {
      rows: [payPeriodRow('ppA'), payPeriodRow('ppB', { status: 'paid', processed_at: '2026-07-01T00:00:00Z' })],
    }
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider(state)

    const bootstrap = source(provider, snapshots)
    expect((await bootstrap.readChanges(null)).changes).toHaveLength(2)
    await bootstrap.flushPending()

    // ppA no longer comes back from the scan at all — only ppB remains,
    // unchanged.
    state.rows = [state.rows[1]]

    const replay = source(provider, snapshots)
    await expect(replay.readChanges(null)).resolves.toMatchObject({ changes: [], hasMore: false })
  })

  it('throws rather than silently normalising a cross-company row', async () => {
    const state = { rows: [payPeriodRow('pp8', { company_id: 'other-company' })] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const bounded = source(fakeProvider(state), snapshots)

    await expect(bounded.readChanges(null)).rejects.toThrow(/scoped to a different company/)
  })
})
