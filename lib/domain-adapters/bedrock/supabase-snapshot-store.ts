import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import {
  snapshotKey,
  type DomainEntitySnapshot,
  type DomainSnapshotKey,
  type DomainSnapshotStore,
} from './snapshot-store'

const TABLE = 'domain_change_source_snapshots'

type SnapshotRow = {
  workspace_id: string
  source_system: string
  source_company_id: string
  source_entity_type: string
  source_entity_id: string
  fingerprint: string
  fields: Record<string, unknown> | null
  observed_at: string
  source_updated_at: string | null
}

/** Durable change-detection state on `domain_change_source_snapshots`. */
export class SupabaseDomainSnapshotStore implements DomainSnapshotStore {
  readonly #client: ReturnType<typeof createServiceClient>

  constructor(client: ReturnType<typeof createServiceClient> = createServiceClient()) {
    this.#client = client
  }

  async loadMany(keys: readonly DomainSnapshotKey[]): Promise<Map<string, DomainEntitySnapshot>> {
    const out = new Map<string, DomainEntitySnapshot>()
    if (keys.length === 0) return out

    // Every key in a batch shares its stream, so one workspace/company/type
    // filter plus an id list is a single index-friendly query rather than N
    // round trips. The scoping columns stay on the query so a stray key from
    // another tenant could not widen it.
    const first = keys[0]
    const ids = [...new Set(keys.map((key) => key.sourceEntityId))]

    const { data, error } = await this.#client
      .from(TABLE)
      .select('*')
      .eq('workspace_id', first.workspaceId)
      .eq('source_system', first.sourceSystem)
      .eq('source_company_id', first.sourceCompanyId)
      .eq('source_entity_type', first.sourceEntityType)
      .in('source_entity_id', ids)

    if (error) throw new Error(`domain snapshot read failed: ${error.message}`)

    for (const row of (data ?? []) as SnapshotRow[]) {
      out.set(
        snapshotKey({
          workspaceId: row.workspace_id,
          sourceSystem: row.source_system,
          sourceCompanyId: row.source_company_id,
          sourceEntityType: row.source_entity_type,
          sourceEntityId: row.source_entity_id,
        }),
        {
          fingerprint: row.fingerprint,
          fields: row.fields ?? {},
          observedAt: row.observed_at,
          sourceUpdatedAt: row.source_updated_at ?? row.observed_at,
        }
      )
    }
    return out
  }

  async saveMany(
    entries: readonly (DomainSnapshotKey & { snapshot: DomainEntitySnapshot })[]
  ): Promise<void> {
    if (entries.length === 0) return

    const { error } = await this.#client.from(TABLE).upsert(
      entries.map((entry) => ({
        workspace_id: entry.workspaceId,
        source_system: entry.sourceSystem,
        source_company_id: entry.sourceCompanyId,
        source_entity_type: entry.sourceEntityType,
        source_entity_id: entry.sourceEntityId,
        fingerprint: entry.snapshot.fingerprint,
        fields: entry.snapshot.fields,
        observed_at: entry.snapshot.observedAt,
        source_updated_at: entry.snapshot.sourceUpdatedAt,
        updated_at: new Date().toISOString(),
      })),
      {
        onConflict:
          'workspace_id,source_system,source_company_id,source_entity_type,source_entity_id',
      }
    )

    if (error) throw new Error(`domain snapshot write failed: ${error.message}`)
  }
}
