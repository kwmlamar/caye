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

/**
 * Bedrock purchase orders, as a stream of `ExternalDomainChange`.
 *
 * This is intentionally a thin, purchase-order-shaped companion to the generic
 * read adapter rather than an event system bolted onto it. The read adapter
 * keeps answering "what is this PO now"; this class answers the narrower
 * question "what changed since I last looked", which is the only thing the
 * projection bridge needs.
 *
 * Acquisition is polling, not webhooks, because Bedrock publishes no change
 * feed. Two mechanisms make polling honest:
 *
 *   - a `(updated_at, id)` keyset cursor, so a scan is resumable and total;
 *   - a fingerprint over the semantically tracked fields, so a row whose
 *     `updated_at` moved for a reason Caye does not care about (an OCR blob, a
 *     note) produces no event at all.
 *
 * Bootstrap is the load-bearing distinction. The first time a PO is seen it is
 * emitted as `operation: 'snapshot'`, never as `created` and never as a
 * transition, because Caye has no evidence about how it reached its current
 * status. A PO that has been `received` for a month must not enter Caye's
 * stream claiming it was just received.
 */

/** The fields a purchase-order change is judged on. Everything else is noise. */
export const PURCHASE_ORDER_TRACKED_FIELDS = [
  'status',
  'project_id',
  'vendor_id',
  'po_number',
  'order_date',
  'expected_delivery_date',
  'actual_delivery_date',
  'subtotal',
  'total_amount',
  'approved_at',
] as const

const CURSOR_SEPARATOR = '|'

export function encodeBedrockCursor(updatedAt: string, id: string): DomainCursor {
  return { value: `${updatedAt}${CURSOR_SEPARATOR}${id}`, watermark: updatedAt }
}

export function decodeBedrockCursor(
  cursor: DomainCursor | null
): { updatedAt: string; id: string } | null {
  if (!cursor?.value) return null
  const index = cursor.value.indexOf(CURSOR_SEPARATOR)
  if (index <= 0) return null
  const updatedAt = cursor.value.slice(0, index)
  const id = cursor.value.slice(index + 1)
  if (!updatedAt || !id) return null
  return { updatedAt, id }
}

function trackedFields(row: BedrockRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of PURCHASE_ORDER_TRACKED_FIELDS) {
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

/** Bedrock timestamps arrive as Postgres text; normalise to ISO for the stream. */
function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

export interface BedrockPurchaseOrderChangeSourceOptions {
  workspaceId: string
  companyId: string
  provider: BedrockReadProvider
  snapshots: DomainSnapshotStore
  /** Rows per poll. The bridge loops until `hasMore` is false. */
  batchSize?: number
  now?: () => Date
}

export class BedrockPurchaseOrderChangeSource implements DomainChangeSource {
  readonly sourceSystem = BEDROCK_SOURCE_SYSTEM
  readonly sourceCompanyId: string
  readonly stream = 'purchase_orders'

  readonly #workspaceId: string
  readonly #provider: BedrockReadProvider
  readonly #snapshots: DomainSnapshotStore
  readonly #batchSize: number
  readonly #now: () => Date

  /**
   * Snapshots observed but not yet durably committed.
   *
   * Held back on purpose. If the snapshot advanced the moment a row was read,
   * a failure between reading and projecting would leave Caye believing it had
   * already accounted for a change it never emitted — the change would be
   * invisible forever, because the next poll would see no difference. Flushing
   * only alongside the checkpoint makes the loss mode "re-observe" rather than
   * "silently drop".
   */
  #pending: (DomainSnapshotKey & { snapshot: DomainEntitySnapshot })[] = []

  constructor(options: BedrockPurchaseOrderChangeSourceOptions) {
    if (!options.workspaceId?.trim()) throw new Error('a Bedrock change source requires a workspaceId')
    if (!options.companyId?.trim()) throw new Error('a Bedrock change source requires a companyId')
    this.#workspaceId = options.workspaceId
    this.sourceCompanyId = options.companyId
    this.#provider = options.provider
    this.#snapshots = options.snapshots
    this.#batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 500)
    this.#now = options.now ?? (() => new Date())
  }

  async readChanges(after: DomainCursor | null): Promise<DomainChangeBatch> {
    const seek = decodeBedrockCursor(after)
    const rows = await this.#provider.listPurchaseOrdersChangedSince(
      this.sourceCompanyId,
      seek,
      this.#batchSize
    )

    if (rows.length === 0) return { changes: [], nextCursor: null, hasMore: false }

    const keys = rows.map((row) => this.#keyFor(String(row.id)))
    const known = await this.#snapshots.loadMany(keys)

    const observedAt = this.#now().toISOString()
    const changes: ExternalDomainChange[] = []
    let lastRow: BedrockRow | null = null

    for (const row of rows) {
      const id = String(row.id)

      // A row whose company_id does not match the connection's company must
      // never be normalised. Reaching here means the query was mis-scoped, so
      // the safe move is to stop the scan rather than file another business's
      // purchase order under this workspace.
      const rowCompanyId = row.company_id == null ? null : String(row.company_id)
      if (rowCompanyId !== this.sourceCompanyId) {
        throw new Error(
          `Bedrock purchase order ${id} is scoped to a different company than the workspace connection`
        )
      }

      lastRow = row
      const key = this.#keyFor(id)
      const fields = trackedFields(row)
      const print = fingerprint(fields)
      const previous = known.get(snapshotKey(key)) ?? null
      const sourceUpdatedAt = isoTimestamp(row.updated_at, observedAt)

      this.#pending.push({
        ...key,
        snapshot: { fingerprint: print, fields, observedAt, sourceUpdatedAt },
      })

      // Nothing Caye tracks moved. The row's updated_at changed for some other
      // reason; that is not an operational event.
      if (previous && previous.fingerprint === print) continue

      changes.push({
        workspaceId: this.#workspaceId,
        sourceSystem: this.sourceSystem,
        sourceCompanyId: this.sourceCompanyId,
        sourceEntityType: 'purchase_order',
        sourceEntityId: id,
        // Deterministic, so a replay of the same observed state derives the
        // same event identity in the bridge rather than a fresh one.
        sourceVersion: print,
        operation: previous ? 'updated' : 'snapshot',
        occurredAt: sourceUpdatedAt,
        observedAt,
        cursor: encodeBedrockCursor(sourceUpdatedAt, id),
        previous: previous ? previous.fields : null,
        current: fields,
        actor: previous
          ? { kind: 'external', label: 'bedrock' }
          // First sight is Caye looking, not Bedrock acting. Attributing a
          // backfill to the outside world would push every pre-existing
          // purchase order into the operator's attention feed at once.
          : { kind: 'system', label: 'bedrock_bootstrap_scan' },
        metadata: {
          stream: this.stream,
          source_updated_at: sourceUpdatedAt,
          ...(previous ? { previous_observed_at: previous.observedAt } : { bootstrap: true }),
        },
      })
    }

    const nextCursor = lastRow
      ? encodeBedrockCursor(isoTimestamp(lastRow.updated_at, observedAt), String(lastRow.id))
      : null

    return { changes, nextCursor, hasMore: rows.length >= this.#batchSize }
  }

  /**
   * Durably records the observations from the batches read so far. Called by
   * the checkpoint decorator immediately before the cursor advances, so
   * snapshot state and cursor state move together or not at all.
   */
  async flushPending(): Promise<void> {
    if (this.#pending.length === 0) return
    const entries = this.#pending
    this.#pending = []
    await this.#snapshots.saveMany(entries)
  }

  #keyFor(sourceEntityId: string): DomainSnapshotKey {
    return {
      workspaceId: this.#workspaceId,
      sourceSystem: this.sourceSystem,
      sourceCompanyId: this.sourceCompanyId,
      sourceEntityType: 'purchase_order',
      sourceEntityId,
    }
  }
}
