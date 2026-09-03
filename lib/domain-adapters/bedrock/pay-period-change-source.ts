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
 * Bedrock pay periods, as a stream of `ExternalDomainChange`.
 *
 * This is the pay-period-shaped companion to `BedrockPurchaseOrderChangeSource`,
 * but it cannot use that mechanism. The keyset sources poll a
 * `(updated_at, id)` cursor because Bedrock maintains `updated_at` on those
 * tables with a `BEFORE UPDATE` trigger. The `pay_periods` table has **no
 * `updated_at` column** at all — verified against the live database, whose
 * columns are `id, start_date, end_date, status, processed_at, processed_by,
 * notes, created_at, voided_at, voided_by, void_reason, reopened_at,
 * reopened_by, reopen_reason, company_id`.
 *
 * A keyset poll on `created_at` would therefore catch newly opened pay
 * periods and silently miss every status transition (`open -> processing ->
 * paid`, plus `voided` / `reopened`) — which is the entire point of watching
 * this table. A change source that quietly misses transitions is worse than
 * no change source at all: it looks like it is working.
 *
 * So this class uses the other mechanism the architecture already provides:
 * a bounded full scan plus fingerprint comparison against
 * `domain_change_source_snapshots`. Every poll re-reads up to `batchSize`
 * pay periods, company-scoped and ordered by `(created_at, id)`, and compares
 * each one's tracked-field fingerprint against its stored snapshot.
 *
 * This is honest and cheap at ODS's current volume — 35 pay periods today —
 * because the whole table fits inside one bounded read. It must not be
 * reused for a source table with more rows than a single bounded scan can
 * cover: unlike the keyset sources, a full scan has no way to "keep going"
 * across polls (`listAllPayPeriods` takes no offset), so rows beyond
 * `batchSize` are simply never observed. Revisit this mechanism, not just its
 * limit, before pointing it at a larger table.
 *
 * Bootstrap is still the load-bearing distinction, exactly as in the keyset
 * sources. The first time a pay period is seen it is emitted as
 * `operation: 'snapshot'`, never as a transition, because Caye has no
 * evidence about how it reached its current status. ODS has 35 existing pay
 * periods, 22 of them already paid — a pay period that has been `paid` for
 * months must not enter Caye's stream claiming payroll was just processed.
 *
 * Deletions are intentionally not handled. A full scan *can* notice that a
 * previously-seen pay period no longer appears (its snapshot key simply
 * stops being refreshed), but this class does not diff "known snapshot ids"
 * against "ids seen this scan" to raise a deletion — `normalize.ts` has no
 * pay-period-deletion path, and inventing one here would be scope creep
 * beyond what this source's job is. A disappeared pay period's snapshot just
 * goes stale and unread; that costs nothing, per `snapshot-store.ts`'s own
 * contract that losing snapshot rows costs a re-bootstrap, never a fact.
 */

/**
 * The fields a pay-period change is judged on. Matches exactly what
 * `normalize.ts`'s `case 'pay_period'` inspects (`status`, `processed_at`,
 * `voided_at`, `void_reason`, `reopened_at`, `reopen_reason`), plus
 * `start_date`/`end_date` so the bootstrap snapshot carries enough context to
 * name the period. Deliberately excludes `processed_by`, `voided_by`,
 * `reopened_by` (user ids) and `notes` — those are not owner-facing change
 * signals.
 */
export const PAY_PERIOD_TRACKED_FIELDS = [
  'status',
  'processed_at',
  'voided_at',
  'void_reason',
  'reopened_at',
  'reopen_reason',
  'start_date',
  'end_date',
] as const

/** Default bound on the full scan. See the class doc for why this must stay small. */
export const DEFAULT_PAY_PERIOD_SCAN_LIMIT = 500

function trackedFields(row: BedrockRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of PAY_PERIOD_TRACKED_FIELDS) {
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

/**
 * Watermark-only cursor: it records *when* the last bounded full scan
 * completed, and nothing else.
 *
 * The keyset sources encode `(updated_at, id)` because that pair is a real
 * resumable position — the next poll can seek strictly past it. A full scan
 * has no equivalent: every poll re-reads the same bounded window from
 * scratch, so there is no partial-scan position to preserve. Encoding a fake
 * `(updated_at, id)`-shaped cursor here would tell the bridge/checkpoint
 * layer this source can resume a partial read, which is not true — it would
 * imply a resumability this mechanism does not have. `readChanges` never
 * reads this value back; it exists purely so an operator or the checkpoint
 * store can see "pay periods were last scanned at T", the same way the other
 * streams' cursors are surfaced.
 */
export function encodePayPeriodScanCursor(observedAt: string): DomainCursor {
  return { value: observedAt, watermark: observedAt }
}

export interface BedrockPayPeriodChangeSourceOptions {
  workspaceId: string
  companyId: string
  provider: BedrockReadProvider
  snapshots: DomainSnapshotStore
  /** Rows scanned per poll. This bounds a full scan, not a keyset page — see the class doc. */
  batchSize?: number
  now?: () => Date
}

export class BedrockPayPeriodChangeSource implements DomainChangeSource {
  readonly sourceSystem = BEDROCK_SOURCE_SYSTEM
  readonly sourceCompanyId: string
  readonly stream = 'pay_periods'

  readonly #workspaceId: string
  readonly #provider: BedrockReadProvider
  readonly #snapshots: DomainSnapshotStore
  readonly #batchSize: number
  readonly #now: () => Date

  /**
   * Snapshots observed but not yet durably committed. Held back for the same
   * reason as the keyset sources: flushing before the checkpoint commits
   * would let a failure between reading and projecting look like Caye had
   * already accounted for a change it never emitted.
   */
  #pending: (DomainSnapshotKey & { snapshot: DomainEntitySnapshot })[] = []

  constructor(options: BedrockPayPeriodChangeSourceOptions) {
    if (!options.workspaceId?.trim()) throw new Error('a Bedrock change source requires a workspaceId')
    if (!options.companyId?.trim()) throw new Error('a Bedrock change source requires a companyId')
    this.#workspaceId = options.workspaceId
    this.sourceCompanyId = options.companyId
    this.#provider = options.provider
    this.#snapshots = options.snapshots
    this.#batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_PAY_PERIOD_SCAN_LIMIT, 1), 500)
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * `after` is intentionally unused for querying. See `encodePayPeriodScanCursor`:
   * this source has no keyset position to resume, so every call is a fresh
   * bounded full scan rather than a continuation of a prior one.
   */
  async readChanges(_after: DomainCursor | null): Promise<DomainChangeBatch> {
    const rows = await this.#provider.listAllPayPeriods(this.sourceCompanyId, this.#batchSize)
    const observedAt = this.#now().toISOString()
    const cursor = encodePayPeriodScanCursor(observedAt)

    if (rows.length === 0) {
      return { changes: [], nextCursor: cursor, hasMore: false }
    }

    const keys = rows.map((row) => this.#keyFor(String(row.id)))
    const known = await this.#snapshots.loadMany(keys)
    const changes: ExternalDomainChange[] = []

    for (const row of rows) {
      const id = String(row.id)

      // A row whose company_id does not match the connection's company must
      // never be normalised. Reaching here means the query was mis-scoped, so
      // the safe move is to stop the scan rather than file another business's
      // pay period under this workspace.
      const rowCompanyId = row.company_id == null ? null : String(row.company_id)
      if (rowCompanyId !== this.sourceCompanyId) {
        throw new Error(
          `Bedrock pay period ${id} is scoped to a different company than the workspace connection`,
        )
      }

      const key = this.#keyFor(id)
      const fields = trackedFields(row)
      const print = fingerprint(fields)
      const previous = known.get(snapshotKey(key)) ?? null

      this.#pending.push({
        ...key,
        snapshot: {
          fingerprint: print,
          fields,
          observedAt,
          // No single authoritative per-row timestamp covers every tracked
          // transition here: processed_at is authoritative for when payroll
          // was processed, but voided/reopened moves it without necessarily
          // moving processed_at, and there is no updated_at at all. Recording
          // the observation time keeps this source's chronology consistent
          // across every kind of transition it detects, rather than being
          // authoritative for one and merely honest for the rest.
          sourceUpdatedAt: observedAt,
        },
      })

      // Nothing Caye tracks moved between this scan and the last one. Skip —
      // this is the case that keeps a full scan from re-emitting on every
      // poll for a pay period whose only "change" is being read again.
      if (previous && previous.fingerprint === print) continue

      changes.push({
        workspaceId: this.#workspaceId,
        sourceSystem: this.sourceSystem,
        sourceCompanyId: this.sourceCompanyId,
        sourceEntityType: 'pay_period',
        sourceEntityId: id,
        // Deterministic, so a replay of the same observed state derives the
        // same event identity in the bridge rather than a fresh one.
        sourceVersion: print,
        operation: previous ? 'updated' : 'snapshot',
        // Caye only knows the pay period now has different tracked fields
        // than last observed, not necessarily when that change happened at
        // the source. processed_at IS authoritative when present, but this
        // source also has to represent voided/reopened transitions that
        // don't move processed_at, and there is no updated_at to fall back
        // on for those. Using the scan's observedAt uniformly is the honest,
        // consistent chronology for every transition this class detects;
        // the authoritative processed_at is still preserved verbatim in
        // `current.processed_at` for anything downstream that wants it.
        occurredAt: observedAt,
        observedAt,
        cursor,
        previous: previous ? previous.fields : null,
        current: fields,
        actor: previous
          ? { kind: 'external', label: 'bedrock' }
          // First sight is Caye looking, not Bedrock acting. Attributing a
          // backfill to the outside world would push every pre-existing pay
          // period into the operator's attention feed at once — 22 of ODS's
          // 35 are already paid.
          : { kind: 'system', label: 'bedrock_bootstrap_scan' },
        metadata: {
          stream: this.stream,
          scan_mechanism: 'full_scan_fingerprint',
          ...(previous ? { previous_observed_at: previous.observedAt } : { bootstrap: true }),
        },
      })
    }

    // Always false: `listAllPayPeriods` takes no offset, so there is no
    // further page to fetch behind this one. If the table holds more rows
    // than `batchSize`, the excess is out of scan range on every poll, not
    // merely deferred to a later batch — the documented limit of this
    // mechanism.
    return { changes, nextCursor: cursor, hasMore: false }
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

  #keyFor(sourceEntityId: string): DomainSnapshotKey {
    return {
      workspaceId: this.#workspaceId,
      sourceSystem: this.sourceSystem,
      sourceCompanyId: this.sourceCompanyId,
      sourceEntityType: 'pay_period',
      sourceEntityId,
    }
  }
}
