import { describe, expect, it } from 'vitest'
import { BedrockPurchaseOrderChangeSource, decodeBedrockCursor, encodeBedrockCursor } from './change-source'
import { InMemoryDomainSnapshotStore } from './snapshot-store'
import type { BedrockReadProvider, BedrockRow } from './provider'

const row = (id: string, updated_at: string, status = 'ordered'): BedrockRow => ({ id, company_id: 'company-1', updated_at, status })
function provider(scan: BedrockRow[], calls: any[]): BedrockReadProvider {
  return new Proxy({}, { get: (_t, prop) => prop === 'listPurchaseOrdersChangedSince'
    ? async (_company: string, after: any, limit: number, notBefore?: string) => { calls.push({ after, limit, notBefore }); return scan }
    : async () => null }) as BedrockReadProvider
}

describe('Bedrock PO corrective cursor semantics', () => {
  it('preserves authoritative microseconds verbatim through cursor encode/decode', () => {
    const ts = '2026-09-01T19:00:00.123456+00:00'
    expect(decodeBedrockCursor(encodeBedrockCursor(ts, 'b'))).toEqual({ updatedAt: ts, id: 'b' })
    expect(encodeBedrockCursor(ts, 'b').watermark).toBe(ts)
  })

  it('queries behind the durable cursor while never regressing the persisted cursor', async () => {
    const calls: any[] = []
    const durable = encodeBedrockCursor('2026-09-01T19:05:00.123456+00:00', 'z')
    const source = new BedrockPurchaseOrderChangeSource({ workspaceId: 'ws-1', companyId: 'company-1', provider: provider([
      row('late-commit', '2026-09-01T19:04:59.999999+00:00', 'received'),
    ], calls), snapshots: new InMemoryDomainSnapshotStore(), now: () => new Date('2026-09-01T19:06:00Z') })
    const batch = await source.readChanges(durable)
    expect(calls[0].notBefore).toBeTruthy()
    expect(new Date(calls[0].notBefore).getTime()).toBeLessThan(new Date('2026-09-01T19:05:00.123456+00:00').getTime())
    expect(batch.changes).toHaveLength(1)
    expect(batch.nextCursor?.value).toBe(durable.value)
  })

  it('uses raw same-timestamp id ordering at a batch boundary', async () => {
    const ts = '2026-09-01T19:00:00.123456+00:00'; const calls: any[] = []
    const source = new BedrockPurchaseOrderChangeSource({ workspaceId: 'ws-1', companyId: 'company-1', provider: provider([row('b', ts)], calls), snapshots: new InMemoryDomainSnapshotStore(), batchSize: 1 })
    const batch = await source.readChanges(encodeBedrockCursor(ts, 'a'))
    expect(batch.nextCursor?.value).toBe(`${ts}|b`)
    expect(decodeBedrockCursor(batch.nextCursor)).toEqual({ updatedAt: ts, id: 'b' })
  })

  it('re-reading an overlapped semantic snapshot is suppressed after snapshot flush', async () => {
    const snapshots = new InMemoryDomainSnapshotStore(); const calls: any[] = []; const ts = '2026-09-01T19:00:00.123456+00:00'
    const p = provider([row('po-1', ts)], calls)
    const first = new BedrockPurchaseOrderChangeSource({ workspaceId: 'ws-1', companyId: 'company-1', provider: p, snapshots })
    expect((await first.readChanges(null)).changes).toHaveLength(1); await first.flushPending()
    const replay = new BedrockPurchaseOrderChangeSource({ workspaceId: 'ws-1', companyId: 'company-1', provider: p, snapshots })
    expect((await replay.readChanges(encodeBedrockCursor('2026-09-01T19:01:00.000000+00:00', 'z'))).changes).toHaveLength(0)
  })
})
