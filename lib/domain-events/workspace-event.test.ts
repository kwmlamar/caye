import { expect, it } from 'vitest'
import { normalizeDomainChange } from './normalize'
import { toWorkspaceEventInsert } from './workspace-event'
import type { ExternalDomainChange } from './types'

it('projects operational domain state into workspace_events without turning it into durable knowledge', () => {
  const change: ExternalDomainChange = {
    workspaceId: 'workspace-1', sourceSystem: 'bedrock', sourceCompanyId: 'ods', sourceEntityType: 'purchase_order',
    sourceEntityId: 'abc', sourceEventId: 'evt-1', operation: 'updated', occurredAt: '2026-09-01T12:00:00Z',
    observedAt: '2026-09-01T12:01:00Z', cursor: { value: '1' }, previous: { status: 'draft' }, current: { status: 'ordered' },
  }
  const [event] = normalizeDomainChange(change, { entityId: 'caye-po' })
  expect(event).toBeDefined()
  const row = toWorkspaceEventInsert(event!)
  expect(row.type).toBe('domain.purchase_order.status_changed')
  expect(row.origin).toBe('app')
  expect(row.payload.epistemic_kind).toBe('operational_event')
  expect(JSON.stringify(row)).not.toContain('business_fact')
  expect(row.payload).toMatchObject({ observed_at: '2026-09-01T12:01:00Z' })
})
