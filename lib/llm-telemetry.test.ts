import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { insert } = vi.hoisted(() => ({ insert: vi.fn(async () => ({ error: null })) }))
vi.mock('./supabase-server', () => ({
  createServiceClient: () => ({ from: () => ({ insert }) }),
}))

import { logGenericLlmUsage } from './llm-telemetry'

beforeEach(() => insert.mockClear())

describe('LLM request telemetry', () => {
  it('persists optional request, role, and loop metadata without prompt content', async () => {
    await logGenericLlmUsage(
      {
        model: 'claude-sonnet-4-6',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheCreationTokens: 40,
      },
      {
        source: 'lib/caye-agent/execute.ts:runToolLoop',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        requestId: 'req-123',
        callerRole: 'founder',
        loopIteration: 3,
      }
    )

    expect(insert).toHaveBeenCalledWith({
      source: 'lib/caye-agent/execute.ts:runToolLoop',
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_creation_tokens: 40,
      workspace_id: '00000000-0000-0000-0000-000000000001',
      request_id: 'req-123',
      caller_role: 'founder',
      loop_iteration: 3,
    })
    expect(JSON.stringify(insert.mock.calls)).not.toContain('prompt')
  })

  it('keeps existing callers compatible by writing null metadata', async () => {
    await logGenericLlmUsage({ model: 'small-model', inputTokens: 1 }, { source: 'legacy-caller' })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      request_id: null,
      caller_role: null,
      loop_iteration: null,
    }))
  })
})
