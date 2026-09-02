import { describe, expect, it } from 'vitest'
import {
  BUSINESS_ENTITY_SUBJECT_TABLE,
  businessEntityIdFromWorkspaceEvent,
  businessEntitySubject,
  workspaceEventEntityRef,
} from './workspace-events'

describe('business entity identity on workspace events', () => {
  const entityId = '22222222-2222-2222-2222-222222222222'

  it('marks a resolved identity and an unresolved one differently', () => {
    expect(workspaceEventEntityRef(entityId)).toEqual({ caye_entity_id: entityId, resolution: 'resolved' })
    expect(workspaceEventEntityRef(null)).toEqual({ caye_entity_id: null, resolution: 'unresolved' })
    expect(workspaceEventEntityRef('   ')).toEqual({ caye_entity_id: null, resolution: 'unresolved' })
  })

  it('reads the identity the domain event bridge writes into the payload', () => {
    const event = {
      subject_table: 'external_domain_entity',
      subject_id: 'bedrock:purchase_order:PO-123',
      payload: {
        entity: { caye_entity_id: entityId, resolution: 'resolved' },
        source: { system: 'bedrock', entity_id: 'PO-123' },
      },
    }
    expect(businessEntityIdFromWorkspaceEvent(event)).toBe(entityId)
  })

  it('reads the identity from the subject when the event is about the entity itself', () => {
    expect(
      businessEntityIdFromWorkspaceEvent({ ...businessEntitySubject(entityId), payload: {} })
    ).toBe(entityId)
    expect(BUSINESS_ENTITY_SUBJECT_TABLE).toBe('business_entities')
  })

  it('returns null rather than falling back to an external id', () => {
    expect(
      businessEntityIdFromWorkspaceEvent({
        subject_table: 'external_domain_entity',
        subject_id: 'bedrock:purchase_order:PO-123',
        payload: { entity: { caye_entity_id: null, resolution: 'unresolved' } },
      })
    ).toBeNull()

    expect(businessEntityIdFromWorkspaceEvent({ subject_table: 'bookings', subject_id: 'abc', payload: null })).toBeNull()
    expect(businessEntityIdFromWorkspaceEvent({ payload: { entity: [] } })).toBeNull()
    expect(businessEntityIdFromWorkspaceEvent({})).toBeNull()
  })
})
