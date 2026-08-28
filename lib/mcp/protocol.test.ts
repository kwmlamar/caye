import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildFounderContextSnapshot: vi.fn(),
  invokeFounderReadCapability: vi.fn(),
}))

vi.mock('@/lib/capabilities/gateway', () => ({
  buildFounderContextSnapshot: mocks.buildFounderContextSnapshot,
  invokeFounderReadCapability: mocks.invokeFounderReadCapability,
}))

import { CAYE_MCP_TOOLS, callCayeMcpTool, mcpToolsListResult } from './protocol'

const observed = {
  status: 'observed' as const,
  data: [{ id: 'goal-1' }],
  evidence: [{ kind: 'record' as const, id: 'goal-1' }],
  executionRef: null,
  auditRef: null,
  failure: null,
}

describe('Caye MCP protocol adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invokeFounderReadCapability.mockResolvedValue(observed)
    mocks.buildFounderContextSnapshot.mockResolvedValue({
      actor: { kind: 'founder' },
      scope: { workspaceId: 'workspace-a' },
      capabilities: [],
      observations: { goals: observed, attention: null, engineeringArtifacts: null },
    })
  })

  it('publishes only the four bounded read tools in deterministic order', () => {
    expect(CAYE_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      'caye_context_snapshot',
      'caye_goals_list',
      'caye_attention_list',
      'caye_engineering_artifacts_list',
    ])
    expect(mcpToolsListResult().tools).toEqual(CAYE_MCP_TOOLS)
  })

  it('maps MCP workspace scope into trusted gateway scope, not capability args', async () => {
    const result = await callCayeMcpTool('founder-user', 'caye_attention_list', { workspaceId: 'workspace-a' })

    expect(mocks.invokeFounderReadCapability).toHaveBeenCalledWith('founder-user', {
      capability: 'attention.list',
      version: 1,
      workspaceId: 'workspace-a',
      args: {},
    })
    expect(result?.structuredContent).toEqual({ result: observed })
    expect(result?.isError).toBe(false)
  })

  it('rejects extra tool arguments instead of forwarding them', async () => {
    const result = await callCayeMcpTool('founder-user', 'caye_goals_list', {
      workspaceId: 'workspace-a',
      actor: { userId: 'spoofed' },
    })

    expect(result?.isError).toBe(true)
    expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
    expect(JSON.stringify(result?.structuredContent)).toContain('invalid_args')
  })

  it('requires workspace scope for workspace-only capabilities', async () => {
    const result = await callCayeMcpTool('founder-user', 'caye_engineering_artifacts_list', {})
    expect(result?.isError).toBe(true)
    expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
  })

  it('preserves failed capability status, evidence semantics, and tool error state', async () => {
    const failed = {
      status: 'failed' as const,
      data: null,
      evidence: [{ kind: 'record' as const, id: 'source-1' }],
      executionRef: null,
      auditRef: 'audit-1',
      failure: { code: 'unavailable' as const, message: 'State unavailable', retryable: true },
    }
    mocks.invokeFounderReadCapability.mockResolvedValue(failed)

    const result = await callCayeMcpTool('founder-user', 'caye_goals_list', {})

    expect(result?.isError).toBe(true)
    expect(result?.structuredContent).toEqual({ result: failed })
  })

  it('keeps founder identity out of the context snapshot transport', async () => {
    const result = await callCayeMcpTool('private-founder-id', 'caye_context_snapshot', { workspaceId: 'workspace-a' })
    expect(mocks.buildFounderContextSnapshot).toHaveBeenCalledWith('private-founder-id', 'workspace-a')
    expect(JSON.stringify(result)).not.toContain('private-founder-id')
  })

  it('returns null for tools outside the fixed MCP catalog', async () => {
    expect(await callCayeMcpTool('founder-user', 'raw_sql', {})).toBeNull()
  })
})
