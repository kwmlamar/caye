import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { DomainCheckpointStore, DomainCursor, DomainSyncCheckpoint } from './types'

/**
 * Durable acquisition cursors, one row per (workspace, source, company,
 * stream) on `domain_sync_cursors`.
 *
 * Cursors are ingestion bookkeeping, never business state: dropping the table
 * costs a re-scan, not a fact. That is why a cursor may be rewritten freely
 * here while `domain_entity_observation_state` — which decides what counts as
 * stale — only ever moves forward, inside the ingestion function.
 */
export class SupabaseDomainCheckpointStore implements DomainCheckpointStore {
  readonly #client: ReturnType<typeof createServiceClient>

  constructor(client: ReturnType<typeof createServiceClient> = createServiceClient()) {
    this.#client = client
  }

  async load(input: {
    workspaceId: string
    sourceSystem: string
    sourceCompanyId: string
    stream: string
  }): Promise<DomainSyncCheckpoint | null> {
    const { data, error } = await this.#client
      .from('domain_sync_cursors')
      .select('cursor, watermark')
      .eq('workspace_id', input.workspaceId)
      .eq('source_system', input.sourceSystem)
      .eq('source_company_id', input.sourceCompanyId)
      .eq('stream', input.stream)
      .maybeSingle()

    if (error) throw new Error(`domain cursor read failed: ${error.message}`)
    if (!data) return null

    const stored = (data as { cursor: unknown; watermark: string | null }).cursor
    const cursor =
      stored && typeof stored === 'object' && typeof (stored as DomainCursor).value === 'string'
        ? ((stored as DomainCursor).value
            ? { value: (stored as DomainCursor).value, watermark: (data as { watermark: string | null }).watermark }
            : null)
        : null

    return { ...input, cursor }
  }

  async commit(checkpoint: DomainSyncCheckpoint): Promise<void> {
    const { error } = await this.#client.from('domain_sync_cursors').upsert(
      {
        workspace_id: checkpoint.workspaceId,
        source_system: checkpoint.sourceSystem,
        source_company_id: checkpoint.sourceCompanyId,
        stream: checkpoint.stream,
        cursor: checkpoint.cursor,
        watermark: checkpoint.cursor?.watermark ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id,source_system,source_company_id,stream' }
    )

    if (error) throw new Error(`domain cursor commit failed: ${error.message}`)
  }
}

/**
 * Wraps a checkpoint store so a polling source's own change-detection state is
 * made durable at the same moment the cursor advances.
 *
 * Ordering matters and is the entire point. The flush runs BEFORE the cursor
 * moves: if the flush fails the cursor stays put and the batch is re-read,
 * which costs duplicate work that the ingestion function then classifies as a
 * duplicate. The reverse order would move the cursor past changes whose
 * observation was never recorded.
 */
export function withPendingObservationFlush(
  store: DomainCheckpointStore,
  source: { flushPending(): Promise<void> }
): DomainCheckpointStore {
  return {
    load: (input) => store.load(input),
    async commit(checkpoint) {
      await source.flushPending()
      await store.commit(checkpoint)
    },
  }
}
