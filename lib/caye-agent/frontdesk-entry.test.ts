import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

vi.mock('server-only', () => ({}))

const mockState = vi.hoisted(() => ({
  historyForModel: [{ role: 'user', content: 'How much for 2 guests?' }] as Anthropic.MessageParam[],
  runToolLoopResult: { newTurns: [] as Anthropic.MessageParam[], replyText: '' },
  runToolLoopThrows: null as Error | null,
  runToolLoopCalls: 0,
  conversationUpdates: [] as unknown[],
  internalMessagesInserted: [] as unknown[],
  persistCalls: [] as unknown[],
  holdPingCalls: [] as unknown[],
  authzDecision: { allowed: true } as
    | { allowed: true }
    | {
        allowed: false
        reason: 'blocked_by_owner_policy' | 'blocked_by_existing_hold' | 'blocked_by_authority_check_error'
        escalation?: { internalContext: string }
      },
  authzCalls: [] as unknown[],
  customerTimezone: null as string | null,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'unified_conversations') {
        return {
          update: (patch: unknown) => ({
            eq: (col: string, val: unknown) => {
              mockState.conversationUpdates.push({ patch, col, val })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      if (table === 'unified_messages') {
        return {
          insert: (row: unknown) => {
            mockState.internalMessagesInserted.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'customers') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { timezone: mockState.customerTimezone } }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('./execute', () => ({
  runToolLoop: async () => {
    mockState.runToolLoopCalls += 1
    if (mockState.runToolLoopThrows) throw mockState.runToolLoopThrows
    return mockState.runToolLoopResult
  },
}))

vi.mock('@/lib/authorize-autonomous-outbound', () => ({
  authorizeAutonomousOutbound: async (...args: unknown[]) => {
    mockState.authzCalls.push(args)
    return mockState.authzDecision
  },
}))

vi.mock('./context', () => ({
  loadFrontDeskConversationContext: async () => ({
    history: mockState.historyForModel,
    historyTimestamps: mockState.historyForModel.map(() => null),
  }),
}))

vi.mock('./situation', () => ({
  loadRelationshipContext: async () => ({ relationship: null, workOpportunities: [] }),
  loadOperationalContext: async () => ({ standingRules: [], businessFacts: [], attentionDelta: null }),
}))

vi.mock('./modes/front-desk-situation', () => ({
  buildFrontDeskSituationSystemPrompt: () => 'system prompt',
}))

vi.mock('@/lib/caye-frontdesk-agent-turns', () => ({
  persistFrontDeskAgentTurns: vi.fn(async (...args: unknown[]) => {
    mockState.persistCalls.push(args)
    return { persisted: 0, alreadyPersisted: false }
  }),
}))

vi.mock('@/lib/whatsapp/triggers', () => ({
  enqueueHoldPing: async (...args: unknown[]) => {
    mockState.holdPingCalls.push(args)
  },
}))

import { runConvergedFrontDeskTurn } from './frontdesk-entry'

const BASE_INPUT = {
  workspaceId: 'ws1',
  conversationId: 'conv1',
  triggeringMessageId: 'msg1',
  businessName: 'Bimini Island Tours',
  channel: 'email' as const,
  contactId: 'contact1',
  contactName: 'Jordan Blake',
  inboundBody: 'How much for 2 guests?',
}

function assistantTextTurn(text: string): Anthropic.MessageParam {
  return { role: 'assistant', content: text }
}

function sendCustomerReplySuccessTurns(): Anthropic.MessageParam[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'send_customer_reply', input: { conversation_id: 'conv1', body: 'Sure!' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: JSON.stringify({ ok: true, status: 'SUCCESS', data: { sent: true, delivered_text: 'Sure!' } }),
        },
      ],
    },
  ]
}

describe('runConvergedFrontDeskTurn', () => {
  beforeEach(() => {
    mockState.historyForModel = [{ role: 'user', content: 'How much for 2 guests?' }]
    mockState.runToolLoopResult = { newTurns: [], replyText: '' }
    mockState.runToolLoopThrows = null
    mockState.runToolLoopCalls = 0
    mockState.conversationUpdates = []
    mockState.internalMessagesInserted = []
    mockState.persistCalls = []
    mockState.holdPingCalls = []
    mockState.authzDecision = { allowed: true }
    mockState.authzCalls = []
  })

  it('blocks before the LLM runs when an owner_only standing rule matches (#88)', async () => {
    mockState.authzDecision = {
      allowed: false,
      reason: 'blocked_by_owner_policy',
      escalation: { internalContext: 'You asked me to always bring you anything that mentions "Full Bimini Experience", so I held this rather than answer it myself.' },
    }

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('held')
    expect(mockState.runToolLoopCalls).toBe(0)
    expect(mockState.authzCalls).toHaveLength(1)
    expect(mockState.authzCalls[0]).toEqual([
      { workspaceId: 'ws1', conversationId: 'conv1', inboundBody: 'How much for 2 guests?' },
    ])
    expect(mockState.conversationUpdates).toHaveLength(1)
    expect(mockState.internalMessagesInserted).toHaveLength(1)
    expect(mockState.holdPingCalls).toHaveLength(1)
    expect(mockState.persistCalls).toHaveLength(0)
  })

  it('blocks before the LLM runs when the conversation already has an owner hold, without re-pinging or touching conversation state (#89 follow-up)', async () => {
    mockState.authzDecision = { allowed: false, reason: 'blocked_by_existing_hold' }

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('held')
    expect(mockState.runToolLoopCalls).toBe(0)
    // Already held before this turn — nothing new to tell the owner. A ping
    // or a conversation-state rewrite here would (a) look like a fresh
    // event every inbound message while held, and (b) stomp the real
    // original human_agent_reason with this generic placeholder.
    expect(mockState.holdPingCalls).toHaveLength(0)
    expect(mockState.conversationUpdates).toHaveLength(0)
    expect(mockState.internalMessagesInserted).toHaveLength(0)
  })

  it('does not generate a duplicate owner ping on repeated inbound turns while a conversation stays held (#89 follow-up)', async () => {
    mockState.authzDecision = { allowed: false, reason: 'blocked_by_existing_hold' }

    await runConvergedFrontDeskTurn(BASE_INPUT)
    await runConvergedFrontDeskTurn({ ...BASE_INPUT, inboundBody: 'Following up — still there?' })
    await runConvergedFrontDeskTurn({ ...BASE_INPUT, inboundBody: 'Any update?' })

    expect(mockState.holdPingCalls).toHaveLength(0)
    expect(mockState.conversationUpdates).toHaveLength(0)
    expect(mockState.internalMessagesInserted).toHaveLength(0)
  })

  it('marks held and pings the owner when the authority check itself fails (fail-closed, #89 follow-up)', async () => {
    mockState.authzDecision = { allowed: false, reason: 'blocked_by_authority_check_error' }

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('held')
    expect(result.holdReason).toContain('owner-authority check failed')
    expect(mockState.runToolLoopCalls).toBe(0)
    // Unlike blocked_by_existing_hold, this IS new information this turn —
    // the owner needs to know the deterministic gate couldn't verify
    // safety, so this must still surface as a real hold + ping.
    expect(mockState.conversationUpdates).toHaveLength(1)
    expect(mockState.internalMessagesInserted).toHaveLength(1)
    expect(mockState.holdPingCalls).toHaveLength(1)
  })

  it('lets an ordinary, non-matching conversation reach the LLM as before', async () => {
    mockState.runToolLoopResult = { newTurns: sendCustomerReplySuccessTurns(), replyText: 'Sure!' }

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('sent')
    expect(mockState.runToolLoopCalls).toBe(1)
  })

  it('reports outcome:sent and persists agent turns when send_customer_reply succeeded', async () => {
    mockState.runToolLoopResult = { newTurns: sendCustomerReplySuccessTurns(), replyText: 'Sure!' }

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('sent')
    expect(result.toolsUsed).toEqual(['send_customer_reply'])
    expect(mockState.persistCalls).toHaveLength(1)
    const call = mockState.persistCalls[0] as unknown[]
    expect(call.slice(1)).toEqual(['ws1', 'conv1', 'msg1', sendCustomerReplySuccessTurns()])
    expect(mockState.holdPingCalls).toHaveLength(0)
  })

  it('reports outcome:held and pings the owner when no send occurred', async () => {
    mockState.runToolLoopResult = { newTurns: [assistantTextTurn('some narration with no tool call')], replyText: 'x' }

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('held')
    expect(mockState.conversationUpdates).toHaveLength(1)
    expect(mockState.conversationUpdates[0]).toMatchObject({ col: 'id', val: 'conv1' })
    expect(mockState.internalMessagesInserted).toHaveLength(1)
    expect(mockState.holdPingCalls).toHaveLength(1)
  })

  it('reports outcome:held when send_customer_reply was called but held (ok:false)', async () => {
    mockState.runToolLoopResult = {
      newTurns: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'send_customer_reply', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: JSON.stringify({ ok: false, status: 'NEEDS_HUMAN', error: 'held' }),
            },
          ],
        },
      ],
      replyText: '',
    }

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)
    expect(result.outcome).toBe('held')
    expect(mockState.holdPingCalls).toHaveLength(1)
  })

  it('fails closed to outcome:error (not the legacy generator) when runToolLoop throws, and still pings the owner', async () => {
    mockState.runToolLoopThrows = new Error('Anthropic API timeout')

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toContain('Anthropic API timeout')
    expect(mockState.holdPingCalls).toHaveLength(1)
    expect(mockState.persistCalls).toHaveLength(0)
  })

  it('reports outcome:sent even when persistence fails — e.g. the migration is not yet applied to production (real finding, 2026-08-16)', async () => {
    mockState.runToolLoopResult = { newTurns: sendCustomerReplySuccessTurns(), replyText: 'Sure!' }
    const persistFrontDeskAgentTurnsMock = await import('@/lib/caye-frontdesk-agent-turns')
    vi.mocked(persistFrontDeskAgentTurnsMock.persistFrontDeskAgentTurns).mockRejectedValueOnce(
      new Error('relation "caye_frontdesk_agent_turns" does not exist')
    )

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    // The customer already got a real reply — this must report 'sent',
    // NOT 'error' or 'held', regardless of the persistence failure.
    expect(result.outcome).toBe('sent')
    expect(mockState.holdPingCalls).toHaveLength(0)
  })

  it('fails closed to outcome:error when the history loader returns nothing (missing triggering row)', async () => {
    mockState.historyForModel = []

    const result = await runConvergedFrontDeskTurn(BASE_INPUT)

    expect(result.outcome).toBe('error')
    expect(mockState.holdPingCalls).toHaveLength(1)
  })
})
