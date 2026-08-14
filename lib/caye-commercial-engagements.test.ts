import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ rpc }) }))
vi.mock('server-only', () => ({}))

import { recordCayeCommercialEngagement } from './caye-commercial-engagements'

describe('Phase 4A commercial engagement RPC seam', () => {
  beforeEach(() => rpc.mockReset().mockResolvedValue({ data: 'engagement-1', error: null }))

  it('records only a source-backed paid engagement; it does not use Sales won', async () => {
    await expect(recordCayeCommercialEngagement({
      workspaceId: 'acquisition-ws', relationshipId: 'relationship-1', engagementType: 'subscription', status: 'active',
      sourceSystem: 'stripe', sourceId: 'evt_1', idempotencyKey: 'stripe:evt_1', startedAt: '2026-08-14T00:00:00Z',
    })).resolves.toBe('engagement-1')
    expect(rpc).toHaveBeenCalledWith('caye_record_commercial_engagement', expect.objectContaining({
      p_workspace_id: 'acquisition-ws', p_relationship_id: 'relationship-1', p_source_system: 'stripe',
      p_source_id: 'evt_1', p_idempotency_key: 'stripe:evt_1',
    }))
  })
})
