import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { toWorkspaceEventInsert } from './workspace-event'
import type { DomainEventSink, DomainEventWriteResult, NormalizedDomainEvent } from './types'

/**
 * Projects normalized domain events into `workspace_events`.
 *
 * Every write goes through `public.ingest_external_domain_event` rather than a
 * plain insert. The decisions that make projection safe — event-level
 * idempotency, the per-entity advisory lock, and the stale-observation guard
 * against the accepted watermark — are enforced inside that function under one
 * transaction. Doing them in TypeScript across several statements would
 * reintroduce exactly the races the function exists to close.
 *
 * The payload is built by `toWorkspaceEventInsert`, so the two projection
 * paths (RPC here, direct envelope there) cannot describe the same event
 * differently.
 */
export class SupabaseDomainEventSink implements DomainEventSink {
  readonly #client: ReturnType<typeof createServiceClient>

  constructor(client: ReturnType<typeof createServiceClient> = createServiceClient()) {
    this.#client = client
  }

  async write(event: NormalizedDomainEvent): Promise<DomainEventWriteResult> {
    const envelope = toWorkspaceEventInsert(event)

    const { data, error } = await this.#client.rpc('ingest_external_domain_event', {
      p_workspace_id: event.workspaceId,
      p_source_system: event.sourceSystem,
      p_source_company_id: event.sourceCompanyId,
      p_source_entity_type: event.sourceEntityType,
      p_source_entity_id: event.sourceEntityId,
      p_caye_entity_id: event.cayeEntityId ?? null,
      p_event_type: event.type,
      p_occurred_at: event.occurredAt,
      p_observed_at: event.observedAt,
      p_idempotency_key: event.idempotencyKey,
      p_source_version: event.sourceVersion ?? null,
      p_actor_kind: envelope.actor_kind,
      p_payload: envelope.payload,
    })

    if (error) throw new Error(`domain event ingestion failed: ${error.message}`)
    return readIngestResult(data)
  }
}

/**
 * Reads the function's jsonb result. Exported because the migration test
 * drives the same function directly against PGlite and must interpret the
 * result identically to production.
 */
export function readIngestResult(data: unknown): DomainEventWriteResult {
  const row = (data ?? {}) as Record<string, unknown>
  const status = row.status
  const id = row.workspace_event_id

  if (status === 'inserted') {
    if (id === null || id === undefined) throw new Error('ingestion reported insert without an event id')
    return { status: 'inserted', workspaceEventId: String(id) }
  }
  if (status === 'duplicate') {
    return id === null || id === undefined
      ? { status: 'duplicate' }
      : { status: 'duplicate', workspaceEventId: String(id) }
  }
  if (status === 'stale') return { status: 'stale' }

  throw new Error(`ingestion returned an unrecognised status: ${String(status)}`)
}
