import { createHash } from 'node:crypto'

import type {
  DomainChangeBatch,
  DomainChangeSource,
  DomainCursor,
  ExternalDomainChange,
} from '@/lib/domain-events/types'
import type { BedrockReadProvider, BedrockRow } from './provider'
import {
  snapshotKey,
  type DomainEntitySnapshot,
  type DomainSnapshotKey,
  type DomainSnapshotStore,
} from './snapshot-store'
import { BEDROCK_SOURCE_SYSTEM } from './types'
import { decodeBedrockCursor, encodeBedrockCursor, BEDROCK_CURSOR_SAFETY_OVERLAP_MS } from './change-source'

/**
 * Bedrock projects, as a stream of `ExternalDomainChange`.
 *
 * This is intentionally a thin, project-shaped companion to the generic read
 * adapter rather than an event system bolted onto it, mirroring
 * `BedrockPurchaseOrderChangeSource`. The read adapter keeps answering "what
 * is this project now"; this class answers the narrower question "what
 * changed since I last looked", which is the only thing the projection
 * bridge needs.
 *
 * Acquisition is polling, not webhooks, because Bedrock publishes no change
 * feed. Three mechanisms make polling honest:
 *
 *   - a `(updated_at, id)` keyset cursor, so a scan is resumable and total;
 *   - a bounded overlap behind the durable cursor, so source timestamp
 *     precision loss cannot strand a row forever;
 *   - a fingerprint over the semantically tracked fields, so a row whose
 *     `updated_at` moved for a reason Caye does not care about produces no
 *     event at all.
 *
 * Bootstrap is the load-bearing distinction. The first time a project is
 * seen it is emitted as `operation: 'snapshot'`, never as `created` and
 * never as a transition, because Caye has no evidence about how it reached
 * its current status. A project that has been `active` for a year must not
 * enter Caye's stream claiming it just became active.
 */

/** The fields a project change is judged on. Everything else is noise. */
export const PROJECT_TRACKED_FIELDS = [
  'status',
  'start_date',
  'estimated_end_date',
  'actual_end_date',
  'name',
  'client_id',
  'contract_value',
  'budget',
] as const

const CURSOR_SAFETY_OVERLAP_MS = BEDROCK_CURSOR_SAFETY_OVERLAP_MS

/** Keep the exact source timestamp text in the durable keyset cursor. */
function rawTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

/** Normalise source chronology only for the event timestamp itself. */
function occurredTimestamp(value: string, fallback: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function overlapFloor(updatedAt: string, overlapMs: number): string {
  const parsed = new Date(updatedAt)
  return Number.isNaN(parsed.getTime())
    ? updatedAt
    : new Date(parsed.getTime() - overlapMs).toISOString()
}

function compareCursorPair(
  a: { updatedAt: string; id: string },
  b: { updatedAt: string; id: string },
): number {
  if (a.updatedAt < b.updatedAt) return -1
  if (a.updatedAt > b.updatedAt) return 1
  return a.id.localeCompare(b.id)
}

function trackedFields(row: BedrockRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of PROJECT_TRACKED_FIELDS) {
    // Normalised to null so an absent column and an explicit null compare equal
    // and cannot manufacture a phantom change on a schema addition.
    out[field] = row[field] ?? null
  }
  return out
}

function fingerprint(fields: Record<string, unknown>): string {
  const canonical = Object.keys(fields)
    .sort()
    .map((key) => [key, fields[key] === undefined ? null : fields[key]])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export interface BedrockProjectChangeSourceOptions {
  workspaceId: string
  companyId: string
  provider: BedrockReadProvider
  snapshots: DomainSnapshotStore
  /** Rows per poll. The bridge loops until `hasMore` is false. */
  batchSize?: number
  now?: () => Date
  /** Safety overlap for source timestamp precision loss; bounded by provider query. */
  cursorSafetyOverlapMs?: number
}

export class BedrockProjectChangeSource implements DomainChangeSource {
  readonly sourceSystem = BEDROCK_SOURCE_SYSTEM
  readonly sourceCompanyId: string
  readonly stream = 'projects'

  readonly #workspaceId: string
  readonly #provider: BedrockReadProvider
  readonly #snapshots: DomainSnapshotStore
  readonly #batchSize: number
  readonly #now: () => Date
  readonly #overlapMs: number

  /**
   * Snapshots observed but not yet durably committed.
   *
   * Held back on purpose. If the snapshot advanced the moment a row was read,
   * a failure between reading and projecting would leave Caye believing it had
   * already accounted for a change it never emitted. Flushing only alongside
   * the checkpoint makes the loss mode "re-observe" rather than "silently
   * drop".
   */
  #pending: (DomainSnapshotKey & { snapshot: DomainEntitySnapshot })[] = []

  /**
   * Page seek is scan-local. It advances through the bounded overlap without
   * regressing the durable checkpoint supplied by the bridge.
   */
  #scanPageSeek: { updatedAt: string; id: string } | null = null
  #scanDurableFloor: { updatedAt: string; id: string } | null = null
  #scanNotBefore: string | null = null

  constructor(options: BedrockProjectChangeSourceOptions) {
    if (!options.workspaceId?.trim()) throw new Error('a Bedrock change source requires a workspaceId')
    if (!options.companyId?.trim()) throw new Error('a Bedrock change source requires a companyId')
    this.#workspaceId = options.workspaceId
    this.sourceCompanyId = options.companyId
    this.#provider = options.provider
    this.#snapshots = options.snapshots
    this.#batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 500)
    this.#now = options.now ?? (() => new Date())
    this.#overlapMs = Math.max(
      0,
      options.cursorSafetyOverlapMs ?? CURSOR_SAFETY_OVERLAP_MS,
    )
  }

  async readChanges(after: DomainCursor | null): Promise<DomainChangeBatch> {
    const durable = decodeBedrockCursor(after)
    if (this.#scanPageSeek === null) {
      this.#scanDurableFloor = durable
      this.#scanNotBefore = durable ? overlapFloor(durable.updatedAt, this.#overlapMs) : null
    }

    const rows = await this.#provider.listProjectsChangedSince(
      this.sourceCompanyId,
      this.#scanPageSeek,
      this.#batchSize,
      this.#scanNotBefore,
    )

    if (rows.length === 0) {
      this.#resetScan()
      return { changes: [], nextCursor: null, hasMore: false }
    }

    const keys = rows.map((row) => this.#keyFor(String(row.id)))
    const known = await this.#snapshots.loadMany(keys)
    const observedAt = this.#now().toISOString()
    const changes: ExternalDomainChange[] = []
    let lastPair: { updatedAt: string; id: string } | null = null

    for (const row of rows) {
      const id = String(row.id)

      // A row whose company_id does not match the connection's company must
      // never be normalised. Reaching here means the query was mis-scoped, so
      // the safe move is to stop the scan rather than file another business's
      // project under this workspace.
      const rowCompanyId = row.company_id == null ? null : String(row.company_id)
      if (rowCompanyId !== this.sourceCompanyId) {
        throw new Error(
          `Bedrock project ${id} is scoped to a different company than the workspace connection`,
        )
      }

      const rawUpdatedAt = rawTimestamp(row.updated_at, observedAt)
      lastPair = { updatedAt: rawUpdatedAt, id }
      const key = this.#keyFor(id)
      const fields = trackedFields(row)
      const print = fingerprint(fields)
      const previous = known.get(snapshotKey(key)) ?? null
      const sourceOccurredAt = occurredTimestamp(rawUpdatedAt, observedAt)

      this.#pending.push({
        ...key,
        snapshot: {
          fingerprint: print,
          fields,
          observedAt,
          sourceUpdatedAt: sourceOccurredAt,
        },
      })

      // Nothing Caye tracks moved. The row's updated_at changed for some other
      // reason; that is not an operational event.
      if (previous && previous.fingerprint === print) continue

      changes.push({
        workspaceId: this.#workspaceId,
        sourceSystem: this.sourceSystem,
        sourceCompanyId: this.sourceCompanyId,
        sourceEntityType: 'project',
        sourceEntityId: id,
        // Deterministic, so a replay of the same observed state derives the
        // same event identity in the bridge rather than a fresh one.
        sourceVersion: print,
        operation: previous ? 'updated' : 'snapshot',
        occurredAt: sourceOccurredAt,
        observedAt,
        // Preserve raw source precision in the cursor even though occurredAt is
        // normalised to an ISO timestamp for workspace-event chronology.
        cursor: encodeBedrockCursor(rawUpdatedAt, id),
        previous: previous ? previous.fields : null,
        current: fields,
        actor: previous
          ? { kind: 'external', label: 'bedrock' }
          // First sight is Caye looking, not Bedrock acting. Attributing a
          // backfill to the outside world would push every pre-existing
          // project into the operator's attention feed at once.
          : { kind: 'system', label: 'bedrock_bootstrap_scan' },
        metadata: {
          stream: this.stream,
          source_updated_at: rawUpdatedAt,
          ...(previous ? { previous_observed_at: previous.observedAt } : { bootstrap: true }),
        },
      })
    }

    this.#scanPageSeek = lastPair

    // The overlap can walk behind the durable cursor. Never let a page from
    // that overlap move the durable checkpoint backward.
    let durableNext = lastPair
    if (
      this.#scanDurableFloor &&
      durableNext &&
      compareCursorPair(durableNext, this.#scanDurableFloor) < 0
    ) {
      durableNext = this.#scanDurableFloor
    }

    const hasMore = rows.length >= this.#batchSize
    if (!hasMore) this.#resetScan()

    return {
      changes,
      nextCursor: durableNext
        ? encodeBedrockCursor(durableNext.updatedAt, durableNext.id)
        : null,
      hasMore,
    }
  }

  /**
   * Durably records observations read so far. Called by the checkpoint
   * decorator immediately before the cursor advances.
   */
  async flushPending(): Promise<void> {
    if (!this.#pending.length) return
    const entries = this.#pending
    this.#pending = []
    await this.#snapshots.saveMany(entries)
  }

  #resetScan() {
    this.#scanPageSeek = null
    this.#scanDurableFloor = null
    this.#scanNotBefore = null
  }

  #keyFor(sourceEntityId: string): DomainSnapshotKey {
    return {
      workspaceId: this.#workspaceId,
      sourceSystem: this.sourceSystem,
      sourceCompanyId: this.sourceCompanyId,
      sourceEntityType: 'project',
      sourceEntityId,
    }
  }
}
