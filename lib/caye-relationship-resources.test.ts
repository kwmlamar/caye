import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ rpc }) }))
vi.mock('server-only', () => ({}))

import { linkCayeRelationshipOperatingWorkspace, revokeCayeRelationshipResource, verifyCayeRelationshipResource } from './caye-relationship-resources'

describe('Phase 4A relationship resource RPC seams', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: 'link-1', error: null }))

  it('keeps acquisition workspace, operating workspace, resource, and verifier explicit', async () => {
    await linkCayeRelationshipOperatingWorkspace({ workspaceId: 'acquisition-ws', relationshipId: 'relationship-1', operatingWorkspaceId: 'customer-ws', verifiedByOperatorId: 7, sourceSystem: 'owner_confirmation', sourceId: 'msg-1', verifiedAt: '2026-08-14T00:00:00Z' })
    await verifyCayeRelationshipResource({ workspaceId: 'acquisition-ws', relationshipId: 'relationship-1', operatingWorkspaceId: 'customer-ws', operatingWorkspaceLinkId: 'link-1', nativeResourceId: 'account-1', verifiedByOperatorId: 7, sourceSystem: 'owner_confirmation', sourceId: 'msg-2', verifiedAt: '2026-08-14T00:00:00Z' })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['caye_link_relationship_operating_workspace', 'caye_verify_relationship_resource'])
    expect(rpc.mock.calls[1][1]).toEqual(expect.objectContaining({ p_operating_workspace_id: 'customer-ws', p_native_resource_id: 'account-1', p_verified_by_operator_id: 7 }))
  })

  it('uses the history-preserving resource revocation RPC', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await expect(revokeCayeRelationshipResource({ workspaceId: 'acquisition-ws', resourceId: 'resource-1', revokedAt: '2026-08-14T00:00:00Z' })).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith('caye_revoke_relationship_resource', expect.objectContaining({ p_resource_id: 'resource-1' }))
  })
})
