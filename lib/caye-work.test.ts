import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ rpc }) }))
vi.mock('server-only', () => ({}))

import { createCayeAuthorization, createCayeJob, reevaluateCayeJob, revokeCayeAuthorization } from './caye-work'

describe('Phase 3 generic work RPC seam', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: 'id-1', error: null }))

  it('passes workspace-operator provenance to authorization creation', async () => {
    await createCayeAuthorization({ workspaceId: 'ws', relationshipId: 'rel', opportunityId: 'opp', authorizer: { kind: 'workspace_operator', operatorId: 7 },
      sourceChannel: 'whatsapp', sourceType: 'unified_message', sourceId: 'message-1', authorityType: 'one_time',
      capabilityKey: 'customer_inbox_response', scopeSubjectKey: 'customer_inquiry_response', scopeDescription: 'next 5', authorizedAt: '2026-08-14T00:00:00Z' })
    expect(rpc).toHaveBeenCalledWith('caye_create_authorization', expect.objectContaining({
      p_workspace_id: 'ws', p_authorizer_kind: 'workspace_operator', p_authorized_by_operator_id: 7,
      p_authorized_by_contact_id: null, p_source_id: 'message-1', p_scope_subject_key: 'customer_inquiry_response',
    }))
  })

  it('keeps an external representative as a relationship contact, never an operator', async () => {
    await createCayeAuthorization({ workspaceId: 'ws', relationshipId: 'rel', opportunityId: 'opp', authorizer: { kind: 'external_representative', contactId: 'contact-1' },
      sourceChannel: 'email', sourceType: 'unified_message', sourceId: 'message-1', authorityType: 'one_time',
      capabilityKey: 'customer_inbox_response', scopeSubjectKey: 'customer_inquiry_response', scopeDescription: 'next 5', scopeMetadata: { max_inquiries: 5 }, authorizedAt: '2026-08-14T00:00:00Z' })
    expect(rpc).toHaveBeenCalledWith('caye_create_authorization', expect.objectContaining({
      p_authorizer_kind: 'external_representative', p_authorized_by_operator_id: null, p_authorized_by_contact_id: 'contact-1',
    }))
  })

  it('keeps job creation and prerequisite reevaluation separate from execution', async () => {
    await createCayeJob({ workspaceId: 'ws', relationshipId: 'rel', opportunityId: 'opp', authorizationId: 'auth',
      owningCapability: 'front_desk', jobKey: 'proof-1', workType: 'bounded', objective: 'Handle five inquiries.', at: '2026-08-14T00:00:00Z' })
    await reevaluateCayeJob({ workspaceId: 'ws', jobId: 'job', at: '2026-08-14T00:00:00Z' })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['caye_create_authorized_job', 'caye_reevaluate_job'])
  })

  it('uses the dedicated history-preserving revocation RPC', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await expect(revokeCayeAuthorization({ workspaceId: 'ws', authorizationId: 'auth', revokedByOperatorId: 7, revokedAt: '2026-08-14T00:00:00Z' })).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith('caye_revoke_authorization', expect.objectContaining({ p_authorization_id: 'auth' }))
  })
})
