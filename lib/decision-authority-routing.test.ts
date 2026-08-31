import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  observe: vi.fn(),
  markNotified: vi.fn(),
  routingAttempts: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/owner-attention', () => ({
  observeAttentionItem: mocks.observe,
  markAttentionNotified: mocks.markNotified,
}))

vi.mock('@/lib/caye-agent/tools/write-low/send-operator-message', () => ({
  sendOperatorMessage: { execute: mocks.send },
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'caye_owner_attention') throw new Error(`unexpected table ${table}`)
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        update: (patch: Record<string, unknown>) => {
          if (Array.isArray(patch.routing_attempts)) {
            mocks.routingAttempts.splice(0, mocks.routingAttempts.length, ...patch.routing_attempts)
          }
          return builder
        },
        maybeSingle: async () => ({ data: { routing_attempts: mocks.routingAttempts }, error: null }),
        then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
      }
      return builder
    },
  }),
}))

import { routeBusinessDecision, type DecisionAuthorityResolution, type DecisionPrincipal } from './decision-authority'

const verifiedAt = '2026-08-30T00:00:00.000Z'
const owner: DecisionPrincipal = {
  id: 1,
  name: 'Mrs. Max',
  role: 'owner',
  verifiedAt,
  directScopes: ['business.*'],
  delegatedScopes: [],
  preferredDelegation: false,
}
const fallback: DecisionPrincipal = {
  id: 7,
  name: 'Delegated operator',
  role: 'staff',
  verifiedAt,
  directScopes: [],
  delegatedScopes: ['business.booking.capacity'],
  preferredDelegation: false,
}
const founder: DecisionPrincipal = {
  id: 13,
  name: 'Lamar',
  role: 'founder',
  verifiedAt,
  directScopes: [],
  delegatedScopes: [],
  preferredDelegation: false,
}

function resolution(principals: DecisionPrincipal[] = [owner, fallback]): DecisionAuthorityResolution {
  return {
    requiredAuthority: 'business.booking.capacity',
    actorAuthorized: false,
    actor: founder,
    authorizedPrincipals: principals,
    preferredDecisionOwner: principals[0] ?? null,
    evidence: { fixture: 'bimini-founder-is-not-owner' },
  }
}

const ctx: any = {
  workspaceId: 'bimini-workspace',
  callerRole: 'founder',
  operatorId: 13,
  requestId: 'req-1',
  origin: 'chat',
}

describe('routeBusinessDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.routingAttempts.splice(0)
    mocks.observe.mockResolvedValue({ id: 'decision-1' })
    mocks.markNotified.mockResolvedValue(undefined)
  })

  it('reproduces the Bimini founder-vs-owner regression and routes to the verified owner', async () => {
    mocks.send.mockResolvedValue({ ok: true, status: 'SUCCESS', data: { sent: true } })

    const result = await routeBusinessDecision({
      ctx,
      domain: 'booking_capacity',
      risk: 'high',
      subjectKey: 'jonathan-capacity',
      summary: 'Approve Jonathan Garcia capacity exception?',
      resolution: resolution([owner]),
    })

    expect(result.resolution.actorAuthorized).toBe(false)
    expect(result.deliveredTo?.id).toBe(owner.id)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][0].operator_allowlist_id).toBe(owner.id)
    expect((result.result.data as any).decision_owner_name).toBe('Mrs. Max')
    expect((result.result.data as any).note).toContain('Do not ask the current caller to approve it')
  })

  it('uses the next authorized principal as a safe fallback when preferred delivery fails', async () => {
    mocks.send
      .mockResolvedValueOnce({ ok: false, status: 'FAILED_PERMANENT', error_code: 'SEND_FAILED', error: 'owner channel unavailable' })
      .mockResolvedValueOnce({ ok: true, status: 'SUCCESS', data: { sent: true } })

    const result = await routeBusinessDecision({
      ctx,
      domain: 'booking_capacity',
      risk: 'high',
      subjectKey: 'capacity-fallback',
      summary: 'Capacity decision needed',
      resolution: resolution(),
    })

    expect(mocks.send.mock.calls.map((call) => call[0].operator_allowlist_id)).toEqual([1, 7])
    expect(result.routed).toBe(true)
    expect(result.deliveredTo?.id).toBe(7)
    expect(mocks.routingAttempts).toHaveLength(2)
  })

  it('keeps the decision pending when every authorized delivery route fails instead of asking the founder to route it', async () => {
    mocks.send.mockResolvedValue({ ok: false, status: 'FAILED_PERMANENT', error_code: 'SEND_FAILED', error: 'unreachable' })

    const result = await routeBusinessDecision({
      ctx,
      domain: 'booking_capacity',
      risk: 'high',
      subjectKey: 'capacity-unreachable',
      summary: 'Capacity decision needed',
      resolution: resolution(),
    })

    expect(result.routed).toBe(false)
    expect(result.attentionId).toBe('decision-1')
    expect((result.result.data as any).persisted).toBe(true)
    expect((result.result.data as any).note).toContain('Do not ask the current caller to approve it or choose a channel')
  })

  it('fails closed and persists unresolved authority rather than promoting the conversation initiator', async () => {
    const unresolved: DecisionAuthorityResolution = {
      requiredAuthority: 'business.booking.capacity',
      actorAuthorized: false,
      actor: founder,
      authorizedPrincipals: [],
      preferredDecisionOwner: null,
      evidence: { failClosed: true },
    }

    const result = await routeBusinessDecision({
      ctx,
      domain: 'booking_capacity',
      risk: 'high',
      subjectKey: 'capacity-no-authority',
      summary: 'Capacity decision needed',
      resolution: unresolved,
    })

    expect(result.result.status).toBe('NEEDS_HUMAN')
    expect(result.attentionId).toBe('decision-1')
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
