import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const mockState = vi.hoisted(() => ({
  conversationRow: null as { human_agent_enabled: boolean } | null,
  conversationError: null as { message: string } | null,
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
    mockState.conversationRow = { human_agent_enabled: false }
    mockState.conversationError = null
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

  it('blocks with blocked_by_existing_hold when the conversation is already held, regardless of message content', async () => {
    mockState.conversationRow = { human_agent_enabled: true }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'Just following up on my last message.',
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

  it('fails CLOSED (blocked) when the conversation-hold lookup errors — uncertainty must not permit an autonomous send', async () => {
    mockState.conversationError = { message: 'connection reset' }

    const decision = await authorizeAutonomousOutbound({
      workspaceId: 'ws1',
      conversationId: 'conv1',
      inboundBody: 'What time does the sunset cruise leave?',
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('blocked_by_authority_check_error')
  })

  it('fails CLOSED (blocked) when the standing-rules fetch errors, even though the conversation itself is not held', async () => {
    mockState.conversationRow = { human_agent_enabled: false }
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
