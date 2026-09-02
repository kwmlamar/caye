import { normalizeDomainChange } from './normalize'
import type {
  DomainChangeSource,
  DomainCheckpointStore,
  DomainEntityResolver,
  DomainEventSink,
  DomainSyncCheckpoint,
} from './types'

export class DomainBridgeScopeError extends Error {}

export type RunDomainBridgeInput = {
  workspaceId: string
  sourceSystem: string
  sourceCompanyId: string
  source: DomainChangeSource
  resolver: DomainEntityResolver
  sink: DomainEventSink
  checkpoints: DomainCheckpointStore
  maxBatches?: number
}

export type RunDomainBridgeResult = {
  scanned: number
  emitted: number
  duplicates: number
  stale: number
  suppressed: number
  unresolved: number
  batches: number
  cursor: string | null
}

/**
 * Consumes already-detected external changes. The adapter owns database access/change detection;
 * this bridge owns tenant isolation, normalization, event projection, and checkpoint advancement.
 * A checkpoint is committed only after every normalized event in the batch is safely accepted.
 */
export async function runDomainEventBridge(input: RunDomainBridgeInput): Promise<RunDomainBridgeResult> {
  if (input.source.sourceSystem !== input.sourceSystem || input.source.sourceCompanyId !== input.sourceCompanyId) {
    throw new DomainBridgeScopeError('Configured source scope does not match adapter scope')
  }

  const existing = await input.checkpoints.load({
    workspaceId: input.workspaceId,
    sourceSystem: input.sourceSystem,
    sourceCompanyId: input.sourceCompanyId,
    stream: input.source.stream,
  })

  let cursor = existing?.cursor ?? null
  const result: RunDomainBridgeResult = {
    scanned: 0,
    emitted: 0,
    duplicates: 0,
    stale: 0,
    suppressed: 0,
    unresolved: 0,
    batches: 0,
    cursor: cursor?.value ?? null,
  }

  const maxBatches = Math.max(1, input.maxBatches ?? 20)
  for (let batchNumber = 0; batchNumber < maxBatches; batchNumber += 1) {
    const batch = await input.source.readChanges(cursor)
    result.batches += 1

    for (const change of batch.changes) {
      result.scanned += 1
      if (
        change.workspaceId !== input.workspaceId ||
        change.sourceSystem !== input.sourceSystem ||
        change.sourceCompanyId !== input.sourceCompanyId
      ) {
        // Never advance the cursor past a cross-tenant/source leak. Failing loudly is safer than losing it.
        throw new DomainBridgeScopeError('External change crossed configured workspace/company/source scope')
      }

      const resolution = await input.resolver.resolve({
        workspaceId: change.workspaceId,
        sourceSystem: change.sourceSystem,
        sourceCompanyId: change.sourceCompanyId,
        sourceEntityType: change.sourceEntityType,
        sourceEntityId: change.sourceEntityId,
      })
      if (!resolution) result.unresolved += 1

      const events = normalizeDomainChange(change, resolution)
      if (events.length === 0) result.suppressed += 1
      for (const event of events) {
        for (const related of event.relatedEntities) {
          const relatedResolution = await input.resolver.resolve({
            workspaceId: change.workspaceId,
            sourceSystem: change.sourceSystem,
            sourceCompanyId: change.sourceCompanyId,
            sourceEntityType: related.sourceEntityType,
            sourceEntityId: related.sourceEntityId,
          })
          related.cayeEntityId = relatedResolution?.entityId ?? null
        }
        const write = await input.sink.write(event)
        if (write.status === 'inserted') result.emitted += 1
        if (write.status === 'duplicate') result.duplicates += 1
        if (write.status === 'stale') result.stale += 1
      }
    }

    if (batch.nextCursor) {
      const checkpoint: DomainSyncCheckpoint = {
        workspaceId: input.workspaceId,
        sourceSystem: input.sourceSystem,
        sourceCompanyId: input.sourceCompanyId,
        stream: input.source.stream,
        cursor: batch.nextCursor,
      }
      await input.checkpoints.commit(checkpoint)
      cursor = batch.nextCursor
      result.cursor = cursor.value
    }

    if (!batch.hasMore) break
    if (!batch.nextCursor) throw new Error('Domain source reported hasMore without a next cursor')
  }

  return result
}
