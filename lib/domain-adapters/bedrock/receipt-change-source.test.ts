import { describe, expect, it } from 'vitest'

import {
  BedrockReceiptChangeSource,
  RECEIPT_TRACKED_FIELDS,
} from './receipt-change-source'
import { InMemoryDomainSnapshotStore } from './snapshot-store'
import type { BedrockReadProvider, BedrockRow } from './provider'

/**
 * Narrow fake: the change source only ever calls `listAllReceipts`, so the
 * fake implements just that and is cast to the full provider interface, the
 * same pattern `change-source.review-fixes.test.ts` uses for purchase orders.
 */
type FakeReceiptProvider = Pick<BedrockReadProvider, 'listAllReceipts'>

function receiptRow(id: string, overrides: Partial<BedrockRow> = {}): BedrockRow {
  return {
    id,
    company_id: 'company-1',
    vendor: 'Mikro',
    status: 'pending',
    project_id: null,
    total_amount: 128.5,
    receipt_date: '2026-08-20',
    created_at: '2026-08-20T10:00:00Z',
    ...overrides,
  }
}

function fakeProvider(
  state: { rows: BedrockRow[] },
  calls: Array<{ companyId: string; limit: number }> = [],
): BedrockReadProvider {
  const fake: FakeReceiptProvider = {
    listAllReceipts: async (companyId: string, limit: number) => {
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
  return new BedrockReceiptChangeSource({
    workspaceId: overrides.workspaceId ?? 'ws-1',
    companyId: overrides.companyId ?? 'company-1',
    provider,
    snapshots,
    batchSize: overrides.batchSize,
    now: overrides.now,
  })
}

describe('BedrockReceiptChangeSource', () => {
  it('tracks exactly the fields normalize.ts inspects for receipts, plus the descriptive minimum', () => {
    expect(RECEIPT_TRACKED_FIELDS).toEqual(
      expect.arrayContaining(['status', 'project_id', 'vendor', 'total_amount', 'receipt_date']),
    )
  })

  it('first sight emits snapshot, never a transition', async () => {
    const state = { rows: [receiptRow('r1', { vendor: 'Virginia Tile' })] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const first = source(fakeProvider(state), snapshots)

    const batch = await first.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    expect(batch.changes[0].operation).toBe('snapshot')
    expect(batch.changes[0].previous).toBeNull()
    expect(batch.changes[0].current).toMatchObject({ vendor: 'Virginia Tile', status: 'pending' })
    // Bootstrap is Caye looking, not Bedrock acting.
    expect(batch.changes[0].actor).toMatchObject({ kind: 'system' })
  })

  it('detects a pending -> processed transition even though no timestamp moved', async () => {
    const state = { rows: [receiptRow('r2', { vendor: 'Mikro', status: 'pending' })] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider(state)

    const bootstrap = source(provider, snapshots)
    expect((await bootstrap.readChanges(null)).changes).toHaveLength(1)
    await bootstrap.flushPending()

    // Only the status flips. created_at (the sole timestamp receipts have)
    // never changes — this is exactly the case the fingerprint mechanism
    // exists for, since a keyset poll on created_at would never see this.
    state.rows = [{ ...state.rows[0], status: 'processed' }]

    const replay = source(provider, snapshots)
    const batch = await replay.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    expect(batch.changes[0].operation).toBe('updated')
    expect(batch.changes[0].previous).toMatchObject({ status: 'pending' })
    expect(batch.changes[0].current).toMatchObject({ status: 'processed' })
    expect(batch.changes[0].actor).toMatchObject({ kind: 'external', label: 'bedrock' })
  })

  it('emits nothing for an unchanged row on a repeat scan', async () => {
    const state = { rows: [receiptRow('r3', { vendor: 'Simple Steps' })] }
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

  it('emits a change when a receipt is newly assigned to a project', async () => {
    const state = { rows: [receiptRow('r4', { vendor: 'Mikro', project_id: null })] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider(state)

    const bootstrap = source(provider, snapshots)
    expect((await bootstrap.readChanges(null)).changes).toHaveLength(1)
    await bootstrap.flushPending()

    state.rows = [{ ...state.rows[0], project_id: 'project-99' }]

    const replay = source(provider, snapshots)
    const batch = await replay.readChanges(null)

    expect(batch.changes).toHaveLength(1)
    expect(batch.changes[0].operation).toBe('updated')
    expect(batch.changes[0].previous).toMatchObject({ project_id: null })
    expect(batch.changes[0].current).toMatchObject({ project_id: 'project-99' })
  })

  it('respects the scan limit', async () => {
    const state = {
      rows: [receiptRow('r5'), receiptRow('r6'), receiptRow('r7')],
    }
    const snapshots = new InMemoryDomainSnapshotStore()
    const calls: Array<{ companyId: string; limit: number }> = []
    const provider = fakeProvider(state, calls)

    const bounded = source(provider, snapshots, { batchSize: 2 })
    const batch = await bounded.readChanges(null)

    expect(calls).toHaveLength(1)
    expect(calls[0].limit).toBe(2)
    expect(batch.changes).toHaveLength(2)
    // No offset parameter exists on listAllReceipts, so there is no further
    // page behind this bounded read.
    expect(batch.hasMore).toBe(false)
  })

  it('does not emit anything, and does not throw, for a receipt that disappeared from the scan', async () => {
    const state = {
      rows: [receiptRow('rA', { vendor: 'Mikro' }), receiptRow('rB', { vendor: 'Simple Steps' })],
    }
    const snapshots = new InMemoryDomainSnapshotStore()
    const provider = fakeProvider(state)

    const bootstrap = source(provider, snapshots)
    expect((await bootstrap.readChanges(null)).changes).toHaveLength(2)
    await bootstrap.flushPending()

    // rA no longer comes back from the scan at all (deleted, or moved out of
    // this company's scope at the source) — only rB remains, unchanged.
    state.rows = [state.rows[1]]

    const replay = source(provider, snapshots)
    await expect(replay.readChanges(null)).resolves.toMatchObject({ changes: [], hasMore: false })
  })

  it('throws rather than silently normalising a cross-company row', async () => {
    const state = { rows: [receiptRow('r8', { company_id: 'other-company' })] }
    const snapshots = new InMemoryDomainSnapshotStore()
    const bounded = source(fakeProvider(state), snapshots)

    await expect(bounded.readChanges(null)).rejects.toThrow(/scoped to a different company/)
  })
})
