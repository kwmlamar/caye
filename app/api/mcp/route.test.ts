import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticateMcpFounder: vi.fn(),
  callCayeMcpTool: vi.fn(),
  mcpDiscoveryResult: vi.fn(),
  mcpToolsListResult: vi.fn(),
}))

vi.mock('@/lib/mcp/auth', () => ({ authenticateMcpFounder: mocks.authenticateMcpFounder }))
vi.mock('@/lib/mcp/protocol', () => ({
  CAYE_MCP_PROTOCOL_VERSION: '2026-07-28',
  callCayeMcpTool: mocks.callCayeMcpTool,
  mcpDiscoveryResult: mocks.mcpDiscoveryResult,
  mcpToolsListResult: mocks.mcpToolsListResult,
}))

import { POST } from './route'

function request(method: string, body: Record<string, unknown>, name?: string) {
  const headers: Record<string, string> = {
    authorization: 'Bearer test-secret',
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  }
  if (name) headers['mcp-name'] = name
  return new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('Caye MCP route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authenticateMcpFounder.mockResolvedValue({ founderUserId: 'founder-user' })
    mocks.mcpToolsListResult.mockReturnValue({ tools: [], ttlMs: 60_000, cacheScope: 'private' })
    mocks.mcpDiscoveryResult.mockReturnValue({ supportedVersions: ['2026-07-28'] })
  })

  it('fails closed before parsing MCP traffic when server auth fails', async () => {
    mocks.authenticateMcpFounder.mockResolvedValue(null)
    const res = await POST(request('tools/list', { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=')
    expect(mocks.mcpToolsListResult).not.toHaveBeenCalled()
  })

  it('serves stateless discovery with modern MCP headers', async () => {
    const res = await POST(request('server/discover', { jsonrpc: '2.0', id: 1, method: 'server/discover' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { supportedVersions: ['2026-07-28'] },
    })
  })

  it('rejects method/header disagreement', async () => {
    const req = request('tools/list', { jsonrpc: '2.0', id: 2, method: 'server/discover' })
    const res = await POST(req)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(-32020)
  })

  it('rejects tool name/header disagreement', async () => {
    const res = await POST(request(
      'tools/call',
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'caye_goals_list', arguments: {} } },
      'caye_attention_list',
    ))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(-32020)
    expect(mocks.callCayeMcpTool).not.toHaveBeenCalled()
  })

  it('injects authenticated founder identity into bounded tool dispatch', async () => {
    mocks.callCayeMcpTool.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { result: { status: 'observed' } },
      isError: false,
      resultType: 'complete',
    })
    const res = await POST(request(
      'tools/call',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'caye_goals_list', arguments: { workspaceId: 'workspace-a' } },
      },
      'caye_goals_list',
    ))

    expect(res.status).toBe(200)
    expect(mocks.callCayeMcpTool).toHaveBeenCalledWith(
      'founder-user',
      'caye_goals_list',
      { workspaceId: 'workspace-a' },
    )
  })

  it('returns a protocol error for tools outside the fixed catalog', async () => {
    mocks.callCayeMcpTool.mockResolvedValue(null)
    const res = await POST(request(
      'tools/call',
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'raw_sql', arguments: {} } },
      'raw_sql',
    ))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(-32602)
  })
})
