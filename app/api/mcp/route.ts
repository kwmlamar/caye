import { NextRequest, NextResponse } from 'next/server'
import { authenticateMcpFounder } from '@/lib/mcp/auth'
import {
  CAYE_MCP_PROTOCOL_VERSION,
  callCayeMcpTool,
  mcpDiscoveryResult,
  mcpToolsListResult,
  type JsonRpcId,
} from '@/lib/mcp/protocol'

export const runtime = 'nodejs'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result })
}

function rpcError(id: JsonRpcId | null, code: number, message: string, status = 400) {
  return NextResponse.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status },
  )
}

function parseRpcRequest(body: unknown): JsonRpcRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (value.jsonrpc !== '2.0') return null
  if (typeof value.id !== 'string' && typeof value.id !== 'number') return null
  if (typeof value.method !== 'string') return null
  if (value.params !== undefined && (!value.params || typeof value.params !== 'object' || Array.isArray(value.params))) return null
  return value as JsonRpcRequest
}

/**
 * Stateless MCP 2026-07-28 endpoint.
 *
 * Authentication is dedicated server-to-server founder auth. Browser founder
 * sessions are intentionally irrelevant here. The MCP layer packages Caye's
 * existing read capability gateway; it does not own business semantics or writes.
 */
export async function POST(req: NextRequest) {
  const auth = authenticateMcpFounder(req.headers.get('authorization'))
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="caye-mcp"' },
    })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return rpcError(null, -32700, 'Parse error')
  }

  const rpc = parseRpcRequest(body)
  if (!rpc) return rpcError(null, -32600, 'Invalid Request')

  const protocolVersion = req.headers.get('mcp-protocol-version')
  const methodHeader = req.headers.get('mcp-method')
  if (protocolVersion !== CAYE_MCP_PROTOCOL_VERSION) {
    return rpcError(rpc.id, -32020, 'Unsupported or missing MCP-Protocol-Version header')
  }
  if (methodHeader !== rpc.method) {
    return rpcError(rpc.id, -32020, 'Mcp-Method header does not match request method')
  }

  if (rpc.method === 'server/discover') {
    if (req.headers.get('mcp-name')) {
      return rpcError(rpc.id, -32020, 'Mcp-Name is not valid for server/discover')
    }
    return rpcResult(rpc.id, mcpDiscoveryResult())
  }

  if (rpc.method === 'tools/list') {
    if (req.headers.get('mcp-name')) {
      return rpcError(rpc.id, -32020, 'Mcp-Name is not valid for tools/list')
    }
    return rpcResult(rpc.id, mcpToolsListResult())
  }

  if (rpc.method === 'tools/call') {
    const name = rpc.params?.name
    const nameHeader = req.headers.get('mcp-name')
    if (typeof name !== 'string' || !name) {
      return rpcError(rpc.id, -32602, 'Tool name is required')
    }
    if (nameHeader !== name) {
      return rpcError(rpc.id, -32020, 'Mcp-Name header does not match tool name')
    }

    const result = await callCayeMcpTool(auth.founderUserId, name, rpc.params?.arguments)
    if (!result) return rpcError(rpc.id, -32602, 'Unknown tool')
    return rpcResult(rpc.id, result)
  }

  return rpcError(rpc.id, -32601, 'Method not found')
}
