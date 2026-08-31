import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({ row: null as any }))

vi.mock('@/lib/decision-authority', () => ({
  resolveWorkspaceDecisionAuthority: vi.fn(async () => ({
    requiredAuthority: 'business.booking.capacity',
    actorAuthorized: true,
    actor: { id: 1, name: 'Verified owner', role: 'owner' },
    authorizedPrincipals: [],
    preferredDecisionOwner: null,
    evidence: {},
  })),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'caye_owner_attention') throw new Error(`unexpected table ${table}`)
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: state.row, error: null }),
      }
      return builder
    },
  }),
}))

import { recordBusinessDecision } from './record-business-decision'

const ctx: any = {
  workspaceId: 'ws-1',
  callerRole: 'owner',
  operatorId: 1,
  requestId: 'req-1',
  origin: 'chat',
}

describe('recordBusinessDecision response safety', () => {
  beforeEach(() => {
    state.row = null
  })

  it('treats an exact duplicate response from the same authorized actor as an idempotent replay', async () => {
    state.row = {
      id: 'decision-1',
      status: 'decided',
      decision: 'approve',
      decided_at: '2026-08-30T20:00:00.000Z',
      decision_actor_operator_id: 1,
      decision_expires_at: '2026-09-01T20:00:00.000Z',
      required_authority: 'business.booking.capacity',
      decision_owner_operator_id: 1,
      decision_evidence: {},
      decision_resume_link: null,
    }

    const result = await recordBusinessDecision.execute({ decision_id: 'decision-1', decision: 'approve' }, ctx)
    expect(result.ok).toBe(true)
    expect((result.data as any).idempotent_replay).toBe(true)
  })

  it('refuses a conflicting duplicate response instead of overwriting the first decision', async () => {
    state.row = {
      id: 'decision-1',
      status: 'decided',
      decision: 'approve',
      decided_at: '2026-08-30T20:00:00.000Z',
      decision_actor_operator_id: 1,
      decision_expires_at: '2026-09-01T20:00:00.000Z',
      required_authority: 'business.booking.capacity',
      decision_owner_operator_id: 1,
      decision_evidence: {},
      decision_resume_link: null,
    }

    const result = await recordBusinessDecision.execute({ decision_id: 'decision-1', decision: 'deny' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('CONFLICT')
  })

  it('refuses a stale pending decision and requires current state to be re-read', async () => {
    state.row = {
      id: 'decision-2',
      status: 'open',
      decision: null,
      decided_at: null,
      decision_actor_operator_id: null,
      decision_expires_at: '2020-01-01T00:00:00.000Z',
      required_authority: 'business.booking.capacity',
      decision_owner_operator_id: 1,
      decision_evidence: {},
      decision_resume_link: null,
    }

    const result = await recordBusinessDecision.execute({ decision_id: 'decision-2', decision: 'approve' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('CONFLICT')
    expect(result.error).toContain('stale')
  })

  it('cannot consume a decision id from another workspace', async () => {
    state.row = null
    const result = await recordBusinessDecision.execute({ decision_id: 'foreign-decision', decision: 'approve' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('NOT_FOUND')
  })
})
