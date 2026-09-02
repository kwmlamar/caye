import { createHash } from 'node:crypto'
import type { DomainChangeBatch, DomainChangeSource, DomainCursor, ExternalDomainChange } from '@/lib/domain-events/types'
import type { BedrockReadProvider, BedrockRow } from './provider'
import { snapshotKey, type DomainEntitySnapshot, type DomainSnapshotKey, type DomainSnapshotStore } from './snapshot-store'
import { BEDROCK_SOURCE_SYSTEM } from './types'

export const PURCHASE_ORDER_TRACKED_FIELDS = ['status','project_id','vendor_id','po_number','order_date','expected_delivery_date','actual_delivery_date','subtotal','total_amount','approved_at'] as const
export const BEDROCK_CURSOR_SAFETY_OVERLAP_MS = 5 * 60 * 1000
const CURSOR_SEPARATOR = '|'

export function encodeBedrockCursor(updatedAt: string, id: string): DomainCursor {
  return { value: `${updatedAt}${CURSOR_SEPARATOR}${id}`, watermark: updatedAt }
}
export function decodeBedrockCursor(cursor: DomainCursor | null): { updatedAt: string; id: string } | null {
  if (!cursor?.value) return null
  const i = cursor.value.indexOf(CURSOR_SEPARATOR)
  if (i <= 0) return null
  const updatedAt = cursor.value.slice(0, i); const id = cursor.value.slice(i + 1)
  return updatedAt && id ? { updatedAt, id } : null
}
function rawTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}
function occurredTimestamp(value: string, fallback: string): string {
  const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}
function overlapFloor(updatedAt: string, overlapMs: number): string {
  const parsed = new Date(updatedAt)
  return Number.isNaN(parsed.getTime()) ? updatedAt : new Date(parsed.getTime() - overlapMs).toISOString()
}
function compareCursorPair(a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }): number {
  if (a.updatedAt < b.updatedAt) return -1
  if (a.updatedAt > b.updatedAt) return 1
  return a.id.localeCompare(b.id)
}
function trackedFields(row: BedrockRow): Record<string, unknown> {
  return Object.fromEntries(PURCHASE_ORDER_TRACKED_FIELDS.map((field) => [field, row[field] ?? null]))
}
function fingerprint(fields: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k] ?? null]))).digest('hex')
}

export interface BedrockPurchaseOrderChangeSourceOptions {
  workspaceId: string; companyId: string; provider: BedrockReadProvider; snapshots: DomainSnapshotStore
  batchSize?: number; now?: () => Date; cursorSafetyOverlapMs?: number
}

export class BedrockPurchaseOrderChangeSource implements DomainChangeSource {
  readonly sourceSystem = BEDROCK_SOURCE_SYSTEM
  readonly sourceCompanyId: string
  readonly stream = 'purchase_orders'
  readonly #workspaceId: string; readonly #provider: BedrockReadProvider; readonly #snapshots: DomainSnapshotStore
  readonly #batchSize: number; readonly #now: () => Date; readonly #overlapMs: number
  #pending: (DomainSnapshotKey & { snapshot: DomainEntitySnapshot })[] = []
  #scanPageSeek: { updatedAt: string; id: string } | null = null
  #scanDurableFloor: { updatedAt: string; id: string } | null = null
  #scanNotBefore: string | null = null

  constructor(options: BedrockPurchaseOrderChangeSourceOptions) {
    if (!options.workspaceId?.trim()) throw new Error('a Bedrock change source requires a workspaceId')
    if (!options.companyId?.trim()) throw new Error('a Bedrock change source requires a companyId')
    this.#workspaceId = options.workspaceId; this.sourceCompanyId = options.companyId; this.#provider = options.provider; this.#snapshots = options.snapshots
    this.#batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 500); this.#now = options.now ?? (() => new Date())
    this.#overlapMs = Math.max(0, options.cursorSafetyOverlapMs ?? BEDROCK_CURSOR_SAFETY_OVERLAP_MS)
  }

  async readChanges(after: DomainCursor | null): Promise<DomainChangeBatch> {
    const durable = decodeBedrockCursor(after)
    if (this.#scanPageSeek === null) {
      this.#scanDurableFloor = durable
      this.#scanNotBefore = durable ? overlapFloor(durable.updatedAt, this.#overlapMs) : null
    }
    const rows = await this.#provider.listPurchaseOrdersChangedSince(this.sourceCompanyId, this.#scanPageSeek, this.#batchSize, this.#scanNotBefore)
    if (rows.length === 0) { this.#resetScan(); return { changes: [], nextCursor: null, hasMore: false } }

    const known = await this.#snapshots.loadMany(rows.map((row) => this.#keyFor(String(row.id))))
    const observedAt = this.#now().toISOString(); const changes: ExternalDomainChange[] = []
    let lastPair: { updatedAt: string; id: string } | null = null

    for (const row of rows) {
      const id = String(row.id); const rowCompanyId = row.company_id == null ? null : String(row.company_id)
      if (rowCompanyId !== this.sourceCompanyId) throw new Error(`Bedrock purchase order ${id} is scoped to a different company than the workspace connection`)
      const rawUpdatedAt = rawTimestamp(row.updated_at, observedAt)
      lastPair = { updatedAt: rawUpdatedAt, id }
      const key = this.#keyFor(id); const fields = trackedFields(row); const print = fingerprint(fields); const previous = known.get(snapshotKey(key)) ?? null
      const sourceOccurredAt = occurredTimestamp(rawUpdatedAt, observedAt)
      this.#pending.push({ ...key, snapshot: { fingerprint: print, fields, observedAt, sourceUpdatedAt: sourceOccurredAt } })
      if (previous && previous.fingerprint === print) continue
      changes.push({ workspaceId: this.#workspaceId, sourceSystem: this.sourceSystem, sourceCompanyId: this.sourceCompanyId,
        sourceEntityType: 'purchase_order', sourceEntityId: id, sourceVersion: print, operation: previous ? 'updated' : 'snapshot',
        occurredAt: sourceOccurredAt, observedAt, cursor: encodeBedrockCursor(rawUpdatedAt, id), previous: previous ? previous.fields : null, current: fields,
        actor: previous ? { kind: 'external', label: 'bedrock' } : { kind: 'system', label: 'bedrock_bootstrap_scan' },
        metadata: { stream: this.stream, source_updated_at: rawUpdatedAt, ...(previous ? { previous_observed_at: previous.observedAt } : { bootstrap: true }) } })
    }

    this.#scanPageSeek = lastPair
    let durableNext = lastPair
    if (this.#scanDurableFloor && durableNext && compareCursorPair(durableNext, this.#scanDurableFloor) < 0) durableNext = this.#scanDurableFloor
    const hasMore = rows.length >= this.#batchSize
    if (!hasMore) this.#resetScan()
    return { changes, nextCursor: durableNext ? encodeBedrockCursor(durableNext.updatedAt, durableNext.id) : null, hasMore }
  }

  async flushPending(): Promise<void> { if (!this.#pending.length) return; const entries = this.#pending; this.#pending = []; await this.#snapshots.saveMany(entries) }
  #resetScan() { this.#scanPageSeek = null; this.#scanDurableFloor = null; this.#scanNotBefore = null }
  #keyFor(sourceEntityId: string): DomainSnapshotKey { return { workspaceId: this.#workspaceId, sourceSystem: this.sourceSystem, sourceCompanyId: this.sourceCompanyId, sourceEntityType: 'purchase_order', sourceEntityId } }
}
