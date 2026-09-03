import { describe, expect, it } from 'vitest'
import { normalizeDomainChange } from './normalize'
import type { ExternalDomainChange } from './types'

function change(overrides: Partial<ExternalDomainChange> = {}): ExternalDomainChange {
  return {
    workspaceId: 'workspace-1',
    sourceSystem: 'bedrock',
    sourceCompanyId: 'ods',
    sourceEntityType: 'purchase_order',
    sourceEntityId: 'po-1',
    operation: 'updated',
    occurredAt: '2026-09-01T12:00:00Z',
    observedAt: '2026-09-01T12:01:00Z',
    sourceVersion: '2026-09-01T12:00:00Z',
    cursor: { value: '100' },
    previous: { status: 'draft', project_id: 'p-1', vendor_id: 'v-1' },
    current: { status: 'ordered', project_id: 'p-1', vendor_id: 'v-1' },
    ...overrides,
  }
}

describe('normalizeDomainChange', () => {
  it('emits one meaningful purchase-order status transition with deterministic identity', () => {
    const first = normalizeDomainChange(change(), { entityId: 'entity-po-1' })
    const replay = normalizeDomainChange(change(), { entityId: 'entity-po-1' })
    expect(first).toHaveLength(1)
    expect(first[0]?.type).toBe('domain.purchase_order.status_changed')
    expect(first[0]?.changes).toEqual([{ field: 'status', previous: 'draft', current: 'ordered' }])
    expect(first[0]?.idempotencyKey).toBe(replay[0]?.idempotencyKey)
  })

  it('emits a project value change when the contract figure moves', () => {
    // A contract value that moves without anyone hearing is how a job ends up
    // executed against a figure nobody agreed to. Change sources already
    // fingerprint this field; before this it was detected and then discarded.
    const events = normalizeDomainChange(
      change({
        sourceEntityType: 'project',
        sourceEntityId: 'proj-christiansen',
        previous: { status: 'active', contract_value: 25945, budget: 25945 },
        current: { status: 'active', contract_value: 33984.48, budget: 25945 },
      }),
      { entityId: 'entity-proj-1' },
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('domain.project.value_changed')
    expect(events[0]?.changeKind).toBe('material_change')
    expect(events[0]?.changes).toEqual([
      { field: 'contract_value', previous: 25945, current: 33984.48 },
    ])
  })

  it('reports a status move and a value move as separate project events', () => {
    // They are different things to know and carry different urgency, so they
    // must not be collapsed into one line in a briefing.
    const events = normalizeDomainChange(
      change({
        sourceEntityType: 'project',
        sourceEntityId: 'proj-1',
        previous: { status: 'planning', contract_value: 10000 },
        current: { status: 'active', contract_value: 12000 },
      }),
      { entityId: 'entity-proj-1' },
    )

    expect(events.map((e) => e.type)).toEqual([
      'domain.project.status_changed',
      'domain.project.value_changed',
    ])
  })

  it('stays silent when a project is touched without its value moving', () => {
    const events = normalizeDomainChange(
      change({
        sourceEntityType: 'project',
        sourceEntityId: 'proj-1',
        previous: { status: 'active', contract_value: 25945, name: 'Old name' },
        current: { status: 'active', contract_value: 25945, name: 'New name' },
      }),
      { entityId: 'entity-proj-1' },
    )

    expect(events).toEqual([])
  })

  it('emits a material estimate amount transition', () => {
    const events = normalizeDomainChange(
      change({
        sourceEntityType: 'estimate',
        sourceEntityId: 'est-1',
        previous: { status: 'draft', total_amount: 1000, subtotal: 900 },
        current: { status: 'draft', total_amount: 1250, subtotal: 1100 },
      }),
      { entityId: 'entity-est-1' },
    )
    expect(events.map((event) => event.type)).toEqual(['domain.estimate.amount_changed'])
  })

  it('suppresses individual time-entry churn', () => {
    expect(
      normalizeDomainChange(
        change({ sourceEntityType: 'time_entry', previous: { regular_hours: 8 }, current: { regular_hours: 7.5 } }),
        { entityId: 'time-entity' },
      ),
    ).toEqual([])
  })

  it('emits daily timesheet submission instead of time-entry edits', () => {
    const events = normalizeDomainChange(
      change({
        sourceEntityType: 'daily_timesheet',
        previous: { submitted_at: null },
        current: { submitted_at: '2026-09-01T18:00:00Z' },
      }),
      { entityId: 'timesheet-entity' },
    )
    expect(events[0]?.type).toBe('domain.daily_timesheet.submitted')
  })

  it('uses a system bootstrap observation rather than fabricating fresh external activity', () => {
    const events = normalizeDomainChange(
      change({ operation: 'snapshot', previous: null, current: { status: 'received' } }),
      { entityId: 'entity-po-1' },
    )
    expect(events[0]?.type).toBe('domain.purchase_order.bootstrap_observed')
    expect(events[0]?.changeKind).toBe('bootstrap')
    expect(events[0]?.actor.kind).toBe('system')
    expect(events[0]?.snapshot).toEqual({ status: 'received' })
  })

  it('retains source and external actor identity when the Caye entity is unmapped', () => {
    const [event] = normalizeDomainChange(change(), null)
    expect(event?.cayeEntityId).toBeNull()
    expect(event?.sourceEntityId).toBe('po-1')
    expect(event?.actor.kind).toBe('unknown')
  })

  it('only exposes worker payroll rows for voids or payment reversals', () => {
    const ordinary = normalizeDomainChange(
      change({ sourceEntityType: 'payroll_entry', previous: { net_pay: 900 }, current: { net_pay: 925 } }),
      { entityId: 'payroll-1' },
    )
    expect(ordinary).toEqual([])

    const voided = normalizeDomainChange(
      change({
        sourceEntityType: 'payroll_entry',
        previous: { voided_at: null, void_reason: null },
        current: { voided_at: '2026-09-01T13:00:00Z', void_reason: 'duplicate' },
      }),
      { entityId: 'payroll-1' },
    )
    expect(voided[0]?.type).toBe('domain.payroll_entry.voided')

    const adjusted = normalizeDomainChange(
      change({
        sourceEntityType: 'payroll_entry',
        previous: { net_pay: 900 }, current: { net_pay: 950 },
        metadata: { material_adjustment: true },
      }),
      { entityId: 'payroll-1' },
    )
    expect(adjusted[0]?.type).toBe('domain.payroll_entry.material_adjustment')
  })
})
