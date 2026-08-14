import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ rpc }) }))
vi.mock('server-only', () => ({}))

import { recordWorkOpportunity, resolveCayeRelationship } from './caye-relationships'

describe('generic relationship and opportunity seams', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: 'entity-1', error: null }))

  it('passes workspace scope into relationship resolution', async () => {
    await resolveCayeRelationship({ workspaceId: 'workspace-a', contactId: 'contact-a', originatingCapability: 'sales', interactionAt: '2026-08-14T00:00:00Z', markEngaged: true })
    expect(rpc).toHaveBeenCalledWith('caye_resolve_relationship', expect.objectContaining({
      p_workspace_id: 'workspace-a', p_contact_id: 'contact-a', p_mark_engaged: true,
    }))
  })

  it('passes evidence, inference, and workspace scope atomically to the opportunity RPC', async () => {
    await recordWorkOpportunity({
      workspaceId: 'workspace-a', relationshipId: 'relationship-a', originatingCapability: 'sales',
      opportunityType: 'customer_communication', capabilityKey: 'customer_inbox_response', subjectKey: 'customer_inquiry_response',
      description: 'Handle inquiries.', inference: 'Caye could help.', confidence: 'high',
      sourceType: 'sales_inbound_message', sourceId: 'provider-1', observedFact: 'Prospect asked for reply help.', observedAt: '2026-08-14T00:00:00Z',
    })
    expect(rpc).toHaveBeenCalledWith('caye_record_work_opportunity', expect.objectContaining({
      p_workspace_id: 'workspace-a', p_relationship_id: 'relationship-a',
      p_observed_fact: 'Prospect asked for reply help.', p_inference: 'Caye could help.',
    }))
  })
})
