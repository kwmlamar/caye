import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveWorkspaceDecisionAuthority: vi.fn(),
  routeBusinessDecision: vi.fn(),
  queueResearchRun: vi.fn(),
  maybeSingle: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/decision-authority', () => ({
  requiredAuthorityForDomain: () => 'business.policy',
  resolveWorkspaceDecisionAuthority: mocks.resolveWorkspaceDecisionAuthority,
  routeBusinessDecision: mocks.routeBusinessDecision,
}))
vi.mock('@/lib/research/runtime', () => ({ queueResearchRun: mocks.queueResearchRun }))
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: mocks.maybeSingle }),
          }),
        }),
      }),
    }),
  }),
}))

import { createCanonicalStrategicDependencies } from '../canonical-adapters'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.maybeSingle.mockResolvedValue({ data: null })
  mocks.resolveWorkspaceDecisionAuthority.mockResolvedValue({
    preferredDecisionOwner: { id: 17, name: 'Owner' },
  })
  mocks.routeBusinessDecision.mockResolvedValue({ routed: true, attentionId: 'opaque' })
  mocks.queueResearchRun.mockResolvedValue({ status: 'queued' })
})

describe('canonical strategic adapters', () => {
  it('resolves business authority independently of the conversational actor', async () => {
    const deps = createCanonicalStrategicDependencies({ workspaceId: 'workspace-1' })
    const authority = await deps.resolveAuthority({ scope: 'business' })
    expect(mocks.resolveWorkspaceDecisionAuthority).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', actorOperatorId: null, requiredAuthority: 'business.policy',
    })
    expect(authority.principalType).toBe('business')
    expect(authority.principalRef).toBe('operator:17')
  })

  it('fails personal authority closed without trusted founder identity', async () => {
    const deps = createCanonicalStrategicDependencies({})
    expect(await deps.resolveAuthority({ scope: 'personal' })).toEqual({
      principalType: 'unknown', principalRef: null, resolvedBy: 'unresolved',
    })
  })

  it('suppresses an already-notified unchanged strategic decision', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { status: 'open', state_fingerprint: 'same', notified_fingerprint: 'same', pending_notification_queue_id: null },
    })
    const deps = createCanonicalStrategicDependencies({ workspaceId: 'workspace-1' })
    const sent = await deps.enqueueCanonicalAttention({
      authority: { principalType: 'business', principalRef: 'operator:17', resolvedBy: 'canonical_authority' },
      kind: 'strategic_intelligence', urgency: 'immediate', title: 'Act now', body: 'Evidence', dedupeKey: 'strategic:v1',
    })
    expect(sent).toBe(false)
    expect(mocks.routeBusinessDecision).not.toHaveBeenCalled()
  })

  it('suppresses a resolved strategic decision even if a caller forgets previous process state', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { status: 'resolved', state_fingerprint: 'x', notified_fingerprint: null, pending_notification_queue_id: null },
    })
    const deps = createCanonicalStrategicDependencies({ workspaceId: 'workspace-1' })
    const sent = await deps.enqueueCanonicalAttention({
      authority: { principalType: 'business', principalRef: 'operator:17', resolvedBy: 'canonical_authority' },
      kind: 'strategic_intelligence', urgency: 'immediate', title: 'Act now', body: 'Evidence', dedupeKey: 'strategic:v1',
    })
    expect(sent).toBe(false)
    expect(mocks.routeBusinessDecision).not.toHaveBeenCalled()
  })

  it('queues deeper research and cross-checks through Research Runtime V1', async () => {
    const deps = createCanonicalStrategicDependencies({ workspaceId: 'workspace-1' })
    const signal = { relevance: .9, materiality: .7, urgency: .4, evidence: [], researchQuestionId: 'question-1' }
    await deps.requestDeeperResearch(signal)
    await deps.requestIndependentCrossCheck(signal)
    expect(mocks.queueResearchRun).toHaveBeenNthCalledWith(1, 'question-1', 'strategic-level-2')
    expect(mocks.queueResearchRun).toHaveBeenNthCalledWith(2, 'question-1', 'strategic-cross-check')
  })
})
