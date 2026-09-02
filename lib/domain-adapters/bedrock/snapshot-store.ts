/**
 * Change-detection state for polled domain sources.
 *
 * Polling gives you the CURRENT row and nothing else. To say "status went from
 * approved to ordered" rather than "status is ordered", something has to
 * remember what Caye last saw. That is all this stores: the small set of
 * semantically tracked fields, plus a fingerprint of them.
 *
 * This is deliberately not a mirror of Bedrock. It holds the tracked fields of
 * the last OBSERVATION, it is never read to answer "what is this purchase
 * order now" (that question goes to Bedrock through the read adapter), and
 * losing the whole table costs one round of bootstrap observations rather than
 * any authoritative state.
 */

export interface DomainEntitySnapshot {
  fingerprint: string
  fields: Record<string, unknown>
  observedAt: string
  sourceUpdatedAt: string
}

export interface DomainSnapshotKey {
  workspaceId: string
  sourceSystem: string
  sourceCompanyId: string
  sourceEntityType: string
  sourceEntityId: string
}

export interface DomainSnapshotStore {
  loadMany(keys: readonly DomainSnapshotKey[]): Promise<Map<string, DomainEntitySnapshot>>
  saveMany(entries: readonly (DomainSnapshotKey & { snapshot: DomainEntitySnapshot })[]): Promise<void>
}

/** Stable map key. JSON-tuple encoded because external ids are opaque. */
export function snapshotKey(key: DomainSnapshotKey): string {
  return JSON.stringify([
    key.workspaceId,
    key.sourceSystem,
    key.sourceCompanyId,
    key.sourceEntityType,
    key.sourceEntityId,
  ])
}

/** In-memory store for tests and for a single-shot backfill. */
export class InMemoryDomainSnapshotStore implements DomainSnapshotStore {
  readonly #rows = new Map<string, DomainEntitySnapshot>()

  async loadMany(keys: readonly DomainSnapshotKey[]): Promise<Map<string, DomainEntitySnapshot>> {
    const out = new Map<string, DomainEntitySnapshot>()
    for (const key of keys) {
      const found = this.#rows.get(snapshotKey(key))
      if (found) out.set(snapshotKey(key), found)
    }
    return out
  }

  async saveMany(
    entries: readonly (DomainSnapshotKey & { snapshot: DomainEntitySnapshot })[]
  ): Promise<void> {
    for (const entry of entries) this.#rows.set(snapshotKey(entry), entry.snapshot)
  }

  get size(): number {
    return this.#rows.size
  }
}
