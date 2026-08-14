import { describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
vi.mock('server-only', () => ({}))

const statusCalls: string[] = []
vi.mock('@/lib/outreach-operational-status', () => ({
  getOutreachOperationalStatus: async (workspaceId: string) => {
    statusCalls.push(workspaceId)
    return { workspaceId, paused: false, sendsToday: { sent: 0, dailyLimit: 50, remaining: 50 }, sourcing: { availableCandidates: 12 }, reasonNoOutreach: '12 sendable leads exist but the last scan did not process them.', telemetryComplete: true }
  },
}))
vi.mock('@/lib/llm-telemetry', () => ({
  loggedMessagesCreate: async (_client: unknown, params: { messages: Anthropic.MessageParam[]; tools?: Array<{ name: string }> }) => {
    const used = params.messages.some((turn) => turn.role === 'user' && Array.isArray(turn.content) && turn.content.some((block) => typeof block === 'object' && (block as { type?: string }).type === 'tool_result'))
    if (!used) {
      expect(params.tools?.some((tool) => tool.name === 'get_outreach_operational_status')).toBe(true)
      return { id: 'one', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'tool_use', id: 'status-call', name: 'get_outreach_operational_status', input: {} }] }
    }
    return { id: 'two', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: "I didn't send outreach today because 12 sendable leads existed but the last scan didn't process them. Outreach isn't paused, and you're at 0/50 sends." }] }
  },
}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }))

import { runToolLoop } from './execute'

describe('Caye Direct outreach operational questions', () => {
  for (const question of ["Why didn't you do any outreach today?", 'Did you do outreach today?', 'Are you paused?', 'Are we out of leads?', "Why aren't emails sending?", 'When will outreach run again?']) {
    it(`uses authoritative status for: ${question}`, async () => {
      statusCalls.length = 0
      const result = await runToolLoop({ client: {} as Anthropic, model: 'claude-sonnet-4-6', maxTokens: 512, systemPrompt: 'Use tools.', initialMessages: [{ role: 'user', content: question }], ctx: { workspaceId: 'ws-live', callerRole: 'founder', requestId: `req-${question}` }, mode: 'back-office' })
      expect(statusCalls).toEqual(['ws-live'])
      expect(result.replyText).toMatch(/^I didn't send outreach today because/)
      expect(result.replyText).not.toMatch(/likely causes|don't have visibility/i)
    })
  }
})
