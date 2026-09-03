import { createHash } from 'node:crypto'

import type {
  DomainChangeBatch,
  DomainChangeSource,
  DomainCursor,
  ExternalDomainChange,
} from '@/lib/domain-events/types'
import type { BedrockReadProvider, BedrockRow } from './provider'
import {
  encodeBedrockCursor,
  decodeBedrockCursor,
  BEDROCK_CURSOR_SAFETY_OVERLAP_MS,
} from './change-source'
import {
  snapshotKey,
  type DomainEntitySnapshot,
  type DomainSnapshotKey,
  type DomainSnapshotStore,
} from './snapshot-store'
import { BEDROCK_SOURCE_SYSTEM } from './types'

/**
 * Bedrock estimates, as a stream of `ExternalDomainChange`.
 *
 * Sibling to `BedrockPurchaseOrderChangeSource`: same keyset-cursor scan,
 * same fingerprint-over-tracked-fields change detection, same bootstrap
 * handling. See `change-source.ts` for the full reasoning; it is not
 * repeated here except where estimates differ.
 *
 * This one exists because of a specific failure mode. ODS's Sept 2026 audit
 * found a $25,945 job that was approved by email, had a deposit and a
 * progress payment collected, and had substantial work built -- with no
 * signed contract, for 36 days. The audit's root cause: "approval triggers
 * nothing automatic. There is no defined step between 'client said yes' and
 * 'crew mobilised.'" An estimate's `status` moving to `approved` is exactly
 * that trigger, and this change source is what makes it fire as a domain
 * event instead of silently sitting in Bedrock.
 *
 * Bootstrap is therefore the load-bearing invariant, more so than usual.
 * ODS has 25 existing estimates. The first time this scan sees any of them,
 * it must emit `operation: 'snapshot'` -- never `created`, never a
 * `draft -> approved` transition -- because Caye has no evidence about how
 * that estimate reached its current status. Misclassifying first sight
 * would put 25 false "estimate approved" alerts on the owner's phone on day
 * one, which is the kind of mistake that loses trust permanently.
 */

/**
 * The fields an estimate change is judged on.
 *
 * This list is deliberately wider than the field set `normalize.ts`'s
 * `case 'estimate'` diffs for `status_changed` / `revision_changed` /
 * `amount_changed` (`status`, `revision`, `revision_number`, `total_amount`,
 * `subtotal`, `overhead_amount`, `profit_amount`, `tax_amount`). It also
 * carries `project_id`, `estimate_number`, `issue_date`, and `title`:
 *
 *   - `project_id` is not diffed by `case 'estimate'`, but `normalize.ts`'s
 *     `related()` helper reads it directly off `change.current` for every
 *     estimate event (bootstrap included) to populate `relatedEntities`.
 *     Leaving it out of the tracked fields would silently drop the
 *     estimate-to-project link from every event this source ever emits.
 *   - `estimate_number`, `issue_date`, and `title` give the bootstrap
 *     `snapshot` payload (the only place `current` is exposed in full)
 *     enough context to be useful on its own -- e.g. "EST-00014, 2026 Site
 *     Improvements -- Governor's Harbour (Rev. 2), draft, $33,984.48" --
 *     without requiring a follow-up read against Bedrock.
 *
 * The trade-off: a poll where only one of those four fields changed (and
 * nothing `case 'estimate'` diffs did) will still fingerprint as different,
 * so it emits an `ExternalDomainChange` that `normalizeDomainChange` turns
 * into zero `NormalizedDomainEvent`s. `PURCHASE_ORDER_TRACKED_FIELDS` in
 * `change-source.ts` already accepts the same trade-off for `po_number`,
 * the delivery dates, `subtotal`, `total_amount`, and `approved_at`, none of
 * which `case 'purchase_order'` diffs. It is silent, harmless noise (an
 * extra snapshot write, no owner-visible effect), not a correctness bug --
 * but it is real, and worth flagging rather than claiming a clean match.
 */
export const ESTIMATE_TRACKED_FIELDS = [
  'status',
  'total_amount',
  'estimate_number',
  'project_id',
  'issue_date',
  'title',
  'revision',
  'revision_number',
  'subtotal',
  'overhead_amount',
  'profit_amount',
  'tax_amount',
] as const

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
  for (const field of ESTIMATE_TRACKED_FIELDS) {
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

export interface BedrockEstimateChangeSourceOptions {
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

export class BedrockEstimateChangeSource implements DomainChangeSource {
  readonly sourceSystem = BEDROCK_SOURCE_SYSTEM
  readonly sourceCompanyId: string
  readonly stream = 'estimates'

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

  constructor(options: BedrockEstimateChangeSourceOptions) {
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
      options.cursorSafetyOverlapMs ?? BEDROCK_CURSOR_SAFETY_OVERLAP_MS,
    )
  }

  async readChanges(after: DomainCursor | null): Promise<DomainChangeBatch> {
    const durable = decodeBedrockCursor(after)
    if (this.#scanPageSeek === null) {
      this.#scanDurableFloor = durable
      this.#scanNotBefore = durable ? overlapFloor(durable.updatedAt, this.#overlapMs) : null
    }

    const rows = await this.#provider.listEstimatesChangedSince(
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
      // estimate under this workspace.
      const rowCompanyId = row.company_id == null ? null : String(row.company_id)
      if (rowCompanyId !== this.sourceCompanyId) {
        throw new Error(
          `Bedrock estimate ${id} is scoped to a different company than the workspace connection`,
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
        sourceEntityType: 'estimate',
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
          // estimate into the operator's attention feed at once -- exactly
          // the false "estimate approved" alert storm this source exists to
          // prevent, not cause.
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
      sourceEntityType: 'estimate',
      sourceEntityId,
    }
  }
}
