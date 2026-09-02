import { createHash } from 'node:crypto'
import type {
  DomainEntityResolution,
  DomainFieldChange,
  DomainRelatedEntity,
  ExternalDomainChange,
  NormalizedDomainEvent,
} from './types'

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function fieldChanges(
  change: ExternalDomainChange,
  fields: readonly string[],
): DomainFieldChange[] {
  const previous = change.previous ?? {}
  const current = change.current ?? {}
  return fields.flatMap((field) => {
    const before = previous[field]
    const after = current[field]
    return stableJson(before) === stableJson(after) ? [] : [{ field, previous: before ?? null, current: after ?? null }]
  })
}

function related(change: ExternalDomainChange): DomainRelatedEntity[] {
  const current = change.current ?? {}
  const rels: DomainRelatedEntity[] = []
  const mappings: Array<[string, string, string]> = [
    ['project_id', 'project', 'project'],
    ['vendor_id', 'vendor', 'vendor'],
    ['client_id', 'client', 'client'],
    ['worker_id', 'worker', 'worker'],
    ['pay_period_id', 'pay_period', 'pay_period'],
  ]
  for (const [field, entityType, role] of mappings) {
    const id = current[field]
    if (typeof id === 'string' && id) {
      rels.push({ role, sourceEntityType: entityType, sourceEntityId: id })
    }
  }
  return rels
}

function eventIdentity(change: ExternalDomainChange, eventType: string, changes: DomainFieldChange[]): string {
  const sourceIdentity = change.sourceEventId
    ? ['source_event', change.sourceEventId, eventType]
    : [
        'derived',
        change.sourceVersion ?? change.occurredAt,
        change.operation,
        eventType,
        changes,
      ]
  return createHash('sha256')
    .update(
      stableJson([
        change.workspaceId,
        change.sourceSystem,
        change.sourceCompanyId,
        change.sourceEntityType,
        change.sourceEntityId,
        sourceIdentity,
      ]),
    )
    .digest('hex')
}

function makeEvent(
  change: ExternalDomainChange,
  resolution: DomainEntityResolution | null,
  suffix: string,
  kind: NormalizedDomainEvent['changeKind'],
  changes: DomainFieldChange[],
  attentionEligible = true,
): NormalizedDomainEvent {
  const type = `domain.${change.sourceEntityType}.${suffix}` as const
  return {
    workspaceId: change.workspaceId,
    type,
    sourceSystem: change.sourceSystem,
    sourceCompanyId: change.sourceCompanyId,
    sourceEntityType: change.sourceEntityType,
    sourceEntityId: change.sourceEntityId,
    sourceEventId: change.sourceEventId,
    sourceVersion: change.sourceVersion,
    cayeEntityId: resolution?.entityId ?? null,
    occurredAt: change.occurredAt,
    observedAt: change.observedAt,
    idempotencyKey: eventIdentity(change, type, changes),
    actor: change.actor ?? { kind: 'unknown' },
    changeKind: kind,
    changes,
    relatedEntities: related(change),
    evidence: change.evidence,
    causationId: change.causationId ?? null,
    correlationId: change.correlationId ?? null,
    sourceMetadata: change.metadata ?? {},
    snapshot: kind === 'bootstrap' ? change.current : null,
    attentionEligible: attentionEligible && resolution !== null,
  }
}

function bootstrap(change: ExternalDomainChange, resolution: DomainEntityResolution | null) {
  const event = makeEvent(change, resolution, 'bootstrap_observed', 'bootstrap', [], false)
  // `attentionEligible: false` is not self-enforcing: the existing workspace
  // feed decides what to raise from `actor_kind`, where 'external' maps to
  // 'outside' and is reportable by definition. A backfill attributed to the
  // outside world would announce every pre-existing record as fresh activity
  // the first time a source is connected. First sight is Caye looking, not the
  // source system acting, so bootstrap is always attributed to the system.
  return [{ ...event, actor: { ...event.actor, kind: 'system' as const } }]
}

export function normalizeDomainChange(
  change: ExternalDomainChange,
  resolution: DomainEntityResolution | null,
): NormalizedDomainEvent[] {
  if (change.operation === 'snapshot') return bootstrap(change, resolution)
  if (change.operation === 'deleted') return [] // Deletion semantics require explicit domain policy, never guess.

  const created = change.operation === 'created' || change.previous === null
  switch (change.sourceEntityType) {
    case 'project': {
      if (created) return [makeEvent(change, resolution, 'created', 'created', [])]
      const events: NormalizedDomainEvent[] = []
      const status = fieldChanges(change, ['status'])
      if (status.length) events.push(makeEvent(change, resolution, 'status_changed', 'transition', status))
      const schedule = fieldChanges(change, ['start_date', 'estimated_end_date', 'actual_end_date'])
      if (schedule.length) events.push(makeEvent(change, resolution, 'schedule_changed', 'material_change', schedule))
      return events
    }
    case 'estimate': {
      if (created) return [makeEvent(change, resolution, 'created', 'created', [])]
      const events: NormalizedDomainEvent[] = []
      const status = fieldChanges(change, ['status'])
      if (status.length) events.push(makeEvent(change, resolution, 'status_changed', 'transition', status))
      const revision = fieldChanges(change, ['revision', 'revision_number'])
      if (revision.length) events.push(makeEvent(change, resolution, 'revision_changed', 'material_change', revision))
      const amount = fieldChanges(change, [
        'total_amount',
        'subtotal',
        'overhead_amount',
        'profit_amount',
        'tax_amount',
      ])
      if (amount.length) events.push(makeEvent(change, resolution, 'amount_changed', 'material_change', amount))
      return events
    }
    case 'purchase_order': {
      if (created) return [makeEvent(change, resolution, 'created', 'created', [])]
      const events: NormalizedDomainEvent[] = []
      const status = fieldChanges(change, ['status'])
      if (status.length) events.push(makeEvent(change, resolution, 'status_changed', 'transition', status))
      const assignment = fieldChanges(change, ['project_id', 'vendor_id'])
      if (assignment.length) events.push(makeEvent(change, resolution, 'assignment_changed', 'material_change', assignment))
      return events
    }
    case 'receipt': {
      if (created) return [makeEvent(change, resolution, 'created', 'created', [])]
      const events: NormalizedDomainEvent[] = []
      const status = fieldChanges(change, ['status'])
      if (status.some((entry) => entry.current === 'processed')) {
        events.push(makeEvent(change, resolution, 'processed', 'transition', status))
      }
      const assignment = fieldChanges(change, ['project_id'])
      if (assignment.length && assignment[0]?.current) {
        events.push(makeEvent(change, resolution, 'assigned_to_project', 'material_change', assignment))
      }
      return events
    }
    case 'time_entry':
      // Individual time edits are deliberately not AI-visible domain events.
      return []
    case 'daily_timesheet': {
      if (created) {
        const submitted = fieldChanges(change, ['submitted_at'])
        return submitted.length && submitted[0]?.current
          ? [makeEvent(change, resolution, 'submitted', 'transition', submitted)]
          : []
      }
      const submitted = fieldChanges(change, ['submitted_at'])
      return submitted.length && submitted[0]?.current
        ? [makeEvent(change, resolution, 'submitted', 'transition', submitted)]
        : []
    }
    case 'pay_period': {
      if (created) return [makeEvent(change, resolution, 'opened', 'created', [])]
      const events: NormalizedDomainEvent[] = []
      const status = fieldChanges(change, ['status'])
      const processed = fieldChanges(change, ['processed_at'])
      if ((processed.length && processed[0]?.current) || status.some((entry) => entry.current === 'processing')) {
        events.push(makeEvent(change, resolution, 'payroll_processed', 'transition', [...status, ...processed]))
      }
      if (status.some((entry) => entry.current === 'paid')) {
        events.push(makeEvent(change, resolution, 'paid', 'transition', status))
      }
      const voided = fieldChanges(change, ['voided_at', 'void_reason'])
      if (voided.some((entry) => entry.field === 'voided_at' && entry.current)) {
        events.push(makeEvent(change, resolution, 'voided', 'material_change', voided))
      }
      const reopened = fieldChanges(change, ['reopened_at', 'reopen_reason'])
      if (reopened.some((entry) => entry.field === 'reopened_at' && entry.current)) {
        events.push(makeEvent(change, resolution, 'reopened', 'material_change', reopened))
      }
      return events
    }
    case 'payroll_entry': {
      // Worker-level payroll rows are high volume. Only explicit void/reversal-like changes escape suppression.
      const voided = fieldChanges(change, ['voided_at', 'void_reason'])
      if (voided.some((entry) => entry.field === 'voided_at' && entry.current)) {
        return [makeEvent(change, resolution, 'voided', 'material_change', voided)]
      }
      const reversal = fieldChanges(change, ['is_paid', 'payment_status'])
      const wasPaid = change.previous?.is_paid === true || change.previous?.payment_status === 'paid'
      const nowPaid = change.current?.is_paid === true || change.current?.payment_status === 'paid'
      if (wasPaid && !nowPaid) return [makeEvent(change, resolution, 'payment_reversed', 'material_change', reversal)]

      if (change.metadata?.material_adjustment === true) {
        const adjustment = fieldChanges(change, [
          'regular_hours', 'overtime_hours', 'gross_pay', 'deductions', 'net_pay', 'total_paid',
        ])
        if (adjustment.length) return [makeEvent(change, resolution, 'material_adjustment', 'material_change', adjustment)]
      }
      return []
    }
    default:
      return []
  }
}
