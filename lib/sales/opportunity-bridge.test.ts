import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ relationship: vi.fn(), opportunity: vi.fn() }))
vi.mock('@/lib/caye-relationships', () => ({
  resolveCayeRelationship: state.relationship,
  recordWorkOpportunity: state.opportunity,
}))
vi.mock('server-only', () => ({}))

import { bridgeSalesInboundToWork } from './opportunity-bridge'

describe('Sales relationship and opportunity bridge', () => {
  beforeEach(() => {
    state.relationship.mockReset().mockResolvedValue('relationship-1')
    state.opportunity.mockReset().mockResolvedValue('opportunity-1')
  })

  it('resolves an engaged relationship for a human Sales inbound without manufacturing work', async () => {
    await expect(bridgeSalesInboundToWork({
      workspaceId: 'workspace-1', contactId: 'contact-1', leadId: 'lead-1',
      providerMessageId: 'provider-1', body: 'How much does Caye cost?', observedAt: '2026-08-14T00:00:00Z',
    })).resolves.toEqual({ relationshipId: 'relationship-1', opportunityId: null })
    expect(state.relationship).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', contactId: 'contact-1', markEngaged: true,
    }))
    expect(state.opportunity).not.toHaveBeenCalled()
  })

  it('records a qualifying direct need with a stable inbound evidence reference', async () => {
    await bridgeSalesInboundToWork({
      workspaceId: 'workspace-1', contactId: 'contact-1', leadId: 'lead-1', conversationId: 'conversation-1',
      providerMessageId: 'provider-1', body: 'We need help keeping up with customer messages.', observedAt: '2026-08-14T00:00:00Z',
    })
    expect(state.opportunity).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1', relationshipId: 'relationship-1', sourceId: 'provider-1',
      sourceType: 'sales_inbound_message', capabilityKey: 'customer_inbox_response',
      provenanceMetadata: { lead_id: 'lead-1', conversation_id: 'conversation-1' },
    }))
  })
})
