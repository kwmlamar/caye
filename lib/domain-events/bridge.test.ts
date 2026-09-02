import { describe, expect, it } from 'vitest'
import { DomainBridgeScopeError, runDomainEventBridge } from './bridge'
import type {
  DomainChangeSource,
  DomainCheckpointStore,
  DomainEventSink,
  DomainSyncCheckpoint,
  ExternalDomainChange,
  NormalizedDomainEvent,
} from './types'

const baseChange: ExternalDomainChange = {
  workspaceId: 'workspace-1',
  sourceSystem: 'bedrock',
  sourceCompanyId: 'ods',
  sourceEntityType: 'purchase_order',
  sourceEntityId: 'po-1',
  sourceEventId: 'change-1',
  sourceVersion: '2026-09-01T12:00:00Z',
  operation: 'updated',
  occurredAt: '2026-09-01T12:00:00Z',
  observedAt: '2026-09-01T12:01:00Z',
  cursor: { value: '10' },
  previous: { status: 'draft' },
  current: { status: 'ordered' },
}

class MemoryCheckpoints implements DomainCheckpointStore {
  checkpoint: DomainSyncCheckpoint | null = null
  commits = 0
  async load() { return this.checkpoint }
  async commit(checkpoint: DomainSyncCheckpoint) { this.checkpoint = checkpoint; this.commits += 1 }
}

class MemorySink implements DomainEventSink {
  seen = new Map<string, NormalizedDomainEvent>()
  staleBefore: string | null = null
  writes = 0
  async write(event: NormalizedDomainEvent) {
    this.writes += 1
    if (this.staleBefore && event.occurredAt < this.staleBefore) return { status: 'stale' as const }
    if (this.seen.has(event.idempotencyKey)) return { status: 'duplicate' as const }
    this.seen.set(event.idempotencyKey, event)
    return { status: 'inserted' as const, workspaceEventId: String(this.seen.size) }
  }
}

function source(changes: ExternalDomainChange[]): DomainChangeSource {
  return {
    sourceSystem: 'bedrock',
    sourceCompanyId: 'ods',
    stream: 'operations',
    async readChanges() { return { changes, nextCursor: { value: '10' }, hasMore: false } },
  }
}

const resolver = { async resolve() { return { entityId: 'entity-po-1' } } }

function run(input: { changes?: ExternalDomainChange[]; sink?: MemorySink; checkpoints?: MemoryCheckpoints } = {}) {
  return runDomainEventBridge({
    workspaceId: 'workspace-1', sourceSystem: 'bedrock', sourceCompanyId: 'ods',
    source: source(input.changes ?? [baseChange]), resolver,
    sink: input.sink ?? new MemorySink(), checkpoints: input.checkpoints ?? new MemoryCheckpoints(),
  })
}

describe('runDomainEventBridge', () => {
  it('makes duplicate source events and replay safe', async () => {
    const sink = new MemorySink()
    const first = await run({ sink })
    const replay = await run({ sink })
    expect(first.emitted).toBe(1)
    expect(replay.duplicates).toBe(1)
    expect(sink.seen.size).toBe(1)
  })

  it('does not advance the checkpoint when a sink write fails, so retry can replay', async () => {
    const checkpoints = new MemoryCheckpoints()
    let failed = false
    const sink: DomainEventSink = {
      async write() { failed = true; throw new Error('temporary write failure') },
    }
    await expect(runDomainEventBridge({
      workspaceId: 'workspace-1', sourceSystem: 'bedrock', sourceCompanyId: 'ods',
      source: source([baseChange]), resolver, sink, checkpoints,
    })).rejects.toThrow('temporary write failure')
    expect(failed).toBe(true)
    expect(checkpoints.commits).toBe(0)
  })

  it('accepts a stale/out-of-order observation without projecting it as a new event', async () => {
    const sink = new MemorySink(); sink.staleBefore = '2026-09-01T13:00:00Z'
    const result = await run({ sink })
    expect(result.stale).toBe(1)
    expect(result.emitted).toBe(0)
  })

  it('fails closed on the wrong workspace or company and never checkpoints past it', async () => {
    const checkpoints = new MemoryCheckpoints()
    await expect(run({ changes: [{ ...baseChange, sourceCompanyId: 'other-company' }], checkpoints }))
      .rejects.toBeInstanceOf(DomainBridgeScopeError)
    expect(checkpoints.commits).toBe(0)
  })

  it('persists unmapped external entity events without changing their external actor semantics', async () => {
    const sink = new MemorySink()
    const externalChange = { ...baseChange, actor: { kind: 'external' as const, label: 'bedrock' } }
    const result = await runDomainEventBridge({
      workspaceId: 'workspace-1', sourceSystem: 'bedrock', sourceCompanyId: 'ods', source: source([externalChange]),
      resolver: { async resolve() { return null } }, sink, checkpoints: new MemoryCheckpoints(),
    })
    expect(result.unresolved).toBe(1)
    const event = [...sink.seen.values()][0]
    expect(event?.cayeEntityId).toBeNull()
    expect(event?.actor.kind).toBe('external')
  })
})
