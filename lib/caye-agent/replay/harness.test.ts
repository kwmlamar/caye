import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

// dry-run.ts (imported by harness.ts) has a `server-only` guard — same
// shim used throughout lib/caye-agent's other tests.
vi.mock('server-only', () => ({}))

import { runReplayTurn, runReplayBatch } from './harness'
import { summarizeReplayResults } from './metrics'
import type { ReplayAgentRunner, ReplayTurnInput } from './types'
import type { Tool, ToolContext } from '../tools/types'

const ctx: ToolContext = { workspaceId: 'ws_test', callerRole: 'owner', requestId: 'req_1' }

function fakeHighRiskTool(executed: { count: number }): Tool<{ conversation_id: string; body: string }> {
  return {
    name: 'send_reply',
    description: 'test',
    risk: 'high',
    roles: ['owner'],
    modes: ['back-office'],
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string' }, body: { type: 'string' } },
      required: ['conversation_id', 'body'],
    },
    async execute() {
      executed.count += 1
      return { ok: true, data: { sent: true } }
    },
  }
}

/**
 * A stub runner mimicking runToolLoop's contract closely enough to
 * exercise the harness's dry-run wrapping and metrics without any network
 * or database access — see harness.ts's header comment on why this must
 * work with an injected runner rather than requiring the real one.
 */
function scriptedRunner(script: {
  callTool?: { name: string; args: unknown }
  finalReply: string
}): ReplayAgentRunner {
  return async (args) => {
    const newTurns: Anthropic.MessageParam[] = []
    if (script.callTool) {
      const tool = args.tools?.find((t) => t.name === script.callTool!.name)
      if (tool) await tool.execute(script.callTool.args as never, args.ctx)
      newTurns.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: script.callTool.name, input: script.callTool.args as never }],
      })
    }
    newTurns.push({ role: 'assistant', content: [{ type: 'text', text: script.finalReply }] })
    return { replyText: script.finalReply, newTurns }
  }
}

function baseInput(overrides: Partial<ReplayTurnInput> = {}): ReplayTurnInput {
  return {
    meta: { caseId: 'test-case', label: 'test', description: 'unit test fixture' },
    mode: 'back-office',
    systemPrompt: 'You are a test agent.',
    messages: [{ role: 'user', content: 'do the thing' }],
    ctx,
    tools: [],
    ...overrides,
  }
}

describe('runReplayTurn', () => {
  it('never calls the real tool execute for a high-risk proposed action', async () => {
    const executed = { count: 0 }
    const tool = fakeHighRiskTool(executed)
    const runner = scriptedRunner({
      callTool: { name: 'send_reply', args: { conversation_id: 'c1', body: 'hi' } },
      finalReply: 'Sent it — take a look.',
    })

    const result = await runReplayTurn(baseInput({ tools: [tool] }), runner, {} as never)

    expect(executed.count).toBe(0)
    expect(result.proposedActions).toHaveLength(1)
    expect(result.proposedActions[0]).toMatchObject({ toolName: 'send_reply', risk: 'high' })
  })

  it('computes structural metrics without any judgment fields', async () => {
    const runner = scriptedRunner({ finalReply: 'Hi Will, welcome back!' })
    const result = await runReplayTurn(baseInput(), runner, {} as never)

    expect(result.structuralMetrics.producedReply).toBe(true)
    expect(result.structuralMetrics.replyOpensWithGreetingPattern).toBe(true)
    expect(result.structuralMetrics.proposedActionCount).toBe(0)
    expect(result.reviewerJudgment).toBeUndefined()
  })

  it('flags no-greeting replies correctly', async () => {
    const runner = scriptedRunner({ finalReply: 'Your spot is confirmed for Saturday.' })
    const result = await runReplayTurn(baseInput(), runner, {} as never)
    expect(result.structuralMetrics.replyOpensWithGreetingPattern).toBe(false)
  })

  it('carries case metadata through to the result', async () => {
    const runner = scriptedRunner({ finalReply: 'ok' })
    const result = await runReplayTurn(
      baseInput({ meta: { caseId: 'nbc-laney-scope', label: 'NBC/Laney', description: 'scope containment' } }),
      runner,
      {} as never
    )
    expect(result.meta.caseId).toBe('nbc-laney-scope')
  })
})

describe('runReplayBatch + summarizeReplayResults', () => {
  it('aggregates structural metrics across turns without requiring review', async () => {
    const runnerA = scriptedRunner({ finalReply: 'Hi there!' })
    const runnerB = scriptedRunner({ finalReply: 'Your spot is held for Saturday.' })

    const resultA = await runReplayTurn(baseInput({ meta: { caseId: 'a', label: 'a', description: 'a' } }), runnerA, {} as never)
    const resultB = await runReplayTurn(baseInput({ meta: { caseId: 'b', label: 'b', description: 'b' } }), runnerB, {} as never)

    const summary = summarizeReplayResults([resultA, resultB])
    expect(summary.totalTurns).toBe(2)
    expect(summary.reviewedCount).toBe(0)
    expect(summary.producedReplyRate).toBe(1)
    expect(summary.greetingPatternRate).toBe(0.5)
    // Judgment-dependent rates must be null, not a misleading 0, when
    // nothing has been reviewed yet.
    expect(summary.scopeExpansionRate).toBeNull()
    expect(summary.correctNoActionRate).toBeNull()
  })

  it('honors runReplayBatch running turns in order', async () => {
    const runner = scriptedRunner({ finalReply: 'ok' })
    const results = await runReplayBatch(
      [
        baseInput({ meta: { caseId: 'first', label: 'first', description: '' } }),
        baseInput({ meta: { caseId: 'second', label: 'second', description: '' } }),
      ],
      runner,
      {} as never
    )
    expect(results.map((r) => r.meta.caseId)).toEqual(['first', 'second'])
  })
})
