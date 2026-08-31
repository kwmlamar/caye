import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const mockState = vi.hoisted(() => ({
  conversationRow: null as { human_agent_enabled: boolean; human_agent_marked_at: string | null } | null,
  conversationError: null as { message: string } | null,
  latestInboundRow: null as { sent_at: string } | null,
  latestInboundError: null as { message: string } | null,
  standingRules: [] as Array<{
    id: string
    trigger_type: 'service_mention' | 'keyword'
    match_value: string
    action: 'escalate' | 'owner_only'
    route_to: 'owner' | 'founder' | 'both'
  }>,
  standingRulesError: null as { message: string } | null,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'unified_conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: mockState.conversationRow, error: mockState.conversationError }),
            }),
          }),
        }
      }
      if (table === 'unified_messages') {
        const chain: Record<string, unknown> = {}
        const self = () => chain
        Object.assign(chain, {
          select: self,
          eq: self,
          order: self,
          limit: self,
          maybeSingle: () => Promise.resolve({ data: mockState.latestInboundRow, error: mockState.latestInboundError }),
        })
        return chain
      }
      if (table === 'caye_standing_rules') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () =>
                    Promise.resolve({
                      data: mockState.standingRulesError ? null : mockState.standingRules,
                      error: mockState.standingRulesError,
                    }),
                }),
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    rpc: () => Promise.resolve({ error: null }),
  }),
}))

import { authorizeAutonomousOutbound } from './authorize-autonomous-outbound'

describe('authorizeAutonomousOutbound', () => {
  beforeEach(() => {
    mockState.conversationRow = { human_agent_enabled: false, human_agent_marked_at: null }
    mockState.conversationError = null
    mockState.latestInboundRow = null
    mockState.latestInboundError = null
    mockState.standingRules = []
    mockState.standingRulesError = null
  })

  it('blocks with blocked_by_owner_policy when an owner_only rule matches', async () => {
    mockState.standingRules = [
      {
        id: 'r1',
        trigger_type: 'service_mention',
        match_value: 'Full Bimini Experience',
        action: 'owner_only',
        route_to: 'owner',
      },
    ]

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'Hi, I would like to book the Full Bimini Experience for 4 people.',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe('blocked_by_owner_policy')
      expect(decision.escalation?.customerFacingMessage).toBeTruthy()
    }
  })

  it('blocks when the newest inbound is the turn that was already held', async () => {
    mockState.conversationRow = {
      human_agent_enabled: true,
      human_agent_marked_at: '2026-08-30T23:34:08.045Z',
    }
    mockState.latestInboundRow = { sent_at: '2026-08-30T23:33:32.043Z' }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'Just following up on my last message.',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('blocked_by_existing_hold')
  })

  it('re-evaluates a genuinely newer customer turn even while an older owner-attention item remains open', async () => {
    // Exact lifecycle shape from the Autumn McNeill incident: a hold was
    // created on Aug 26, then a new logistics question arrived Aug 30. The
    // older hold may remain visible to the owner, but it must not prevent
    // this newer turn from reaching the normal evidence/policy/send gates.
    mockState.conversationRow = {
      human_agent_enabled: true,
      human_agent_marked_at: '2026-08-26T23:34:08.045Z',
    }
    mockState.latestInboundRow = { sent_at: '2026-08-30T23:33:32.043Z' }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'Could you provide the instructions on how to get to the tour from the cruise port?',
    })

    expect(decision).toEqual({ allowed: true })
  })

  it('still applies owner_only rules to a fresh turn after an older hold', async () => {
    mockState.conversationRow = {
      human_agent_enabled: true,
      human_agent_marked_at: '2026-08-26T23:34:08.045Z',
    }
    mockState.latestInboundRow = { sent_at: '2026-08-30T23:33:32.043Z' }
    mockState.standingRules = [
      {
        id: 'r1',
        trigger_type: 'service_mention',
        match_value: 'Full Bimini Experience',
        action: 'owner_only',
        route_to: 'owner',
      },
    ]

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'Can you add the Full Bimini Experience too?',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('blocked_by_owner_policy')
  })

  it('keeps a legacy hold with no marked timestamp blocked rather than guessing', async () => {
    mockState.conversationRow = { human_agent_enabled: true, human_agent_marked_at: null }
    mockState.latestInboundRow = { sent_at: '2026-08-30T23:33:32.043Z' }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'What time does the sunset cruise leave?',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('blocked_by_existing_hold')
  })

  it('allows an ordinary conversation with no matching rule and no hold', async () => {
    mockState.standingRules = [
      {
        id: 'r1',
        trigger_type: 'service_mention',
        match_value: 'Full Bimini Experience',
        action: 'owner_only',
        route_to: 'owner',
      },
    ]

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'What time does the sunset cruise leave?',
    })

    expect(decision).toEqual({ allowed: true })
  })

  it('does not hard-block on a plain escalate rule — standdown remains that rule’s to decide', async () => {
    mockState.standingRules = [
      {
        id: 'r2',
        trigger_type: 'keyword',
        match_value: 'group rate',
        action: 'escalate',
        route_to: 'owner',
      },
    ]

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'Can I get a group rate?',
    })

    expect(decision).toEqual({ allowed: true })
  })

  it('fails CLOSED when the conversation-hold lookup errors', async () => {
    mockState.conversationError = { message: 'connection reset' }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'What time does the sunset cruise leave?',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('blocked_by_authority_check_error')
  })

  it('fails CLOSED when checking the newest inbound for a held conversation errors', async () => {
    mockState.conversationRow = {
      human_agent_enabled: true,
      human_agent_marked_at: '2026-08-26T23:34:08.045Z',
    }
    mockState.latestInboundError = { message: 'timeout' }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'What time does the sunset cruise leave?',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('blocked_by_authority_check_error')
  })

  it('fails CLOSED when the standing-rules fetch errors, even though the conversation itself is not held', async () => {
    mockState.conversationRow = { human_agent_enabled: false, human_agent_marked_at: null }
    mockState.conversationError = null
    mockState.standingRulesError = { message: 'relation "caye_standing_rules" does not exist' }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'What time does the sunset cruise leave?',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('blocked_by_authority_check_error')
  })
})
