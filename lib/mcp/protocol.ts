import 'server-only'

import {
  buildFounderContextSnapshot,
  invokeFounderReadCapability,
} from '@/lib/capabilities/gateway'
import type { CapabilityResult } from '@/lib/capabilities/types'

export const CAYE_MCP_PROTOCOL_VERSION = '2026-07-28' as const
export const CAYE_MCP_SERVER_INFO = { name: 'caye', version: '0.1.0' } as const

export type JsonRpcId = string | number

type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

const WORKSPACE_PROPERTY = {
  type: ['string', 'null'],
  description: 'Caye workspace id. Omit or use null only for operator-scope tools that allow it.',
} as const

const CAPABILITY_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['status', 'data', 'evidence', 'executionRef', 'auditRef', 'failure'],
  properties: {
    status: { enum: ['observed', 'inferred', 'staged', 'executed', 'failed'] },
    data: {},
    evidence: { type: 'array' },
    executionRef: { type: ['string', 'null'] },
    auditRef: { type: ['string', 'null'] },
    failure: { type: ['object', 'null'] },
  },
} as const

export const CAYE_MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'caye_context_snapshot',
    description: 'Read Caye founder context for operator scope or one explicit workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { workspaceId: WORKSPACE_PROPERTY },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['snapshot'],
      properties: { snapshot: { type: 'object' } },
    },
  },
  {
    name: 'caye_goals_list',
    description: 'List Caye durable goals for operator scope or exactly one workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { workspaceId: WORKSPACE_PROPERTY },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: { result: CAPABILITY_RESULT_SCHEMA },
    },
  },
  {
    name: 'caye_attention_list',
    description: 'List unresolved founder attention for exactly one Caye workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId'],
      properties: { workspaceId: { type: 'string', minLength: 1 } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: { result: CAPABILITY_RESULT_SCHEMA },
    },
  },
  {
    name: 'caye_engineering_artifacts_list',
    description: 'List trusted engineering artifact metadata for exactly one Caye workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId'],
      properties: { workspaceId: { type: 'string', minLength: 1 } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['result'],
      properties: { result: CAPABILITY_RESULT_SCHEMA },
    },
  },
] as const

const CAPABILITY_BY_TOOL = {
  caye_goals_list: 'goals.list',
  caye_attention_list: 'attention.list',
  caye_engineering_artifacts_list: 'engineering.artifacts.list',
} as const

type ToolName = (typeof CAYE_MCP_TOOLS)[number]['name']

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
  isError: boolean
  resultType: 'complete'
  _meta: { 'io.modelcontextprotocol/serverInfo': typeof CAYE_MCP_SERVER_INFO }
}

function toolResult(structuredContent: Record<string, unknown>, isError: boolean): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': CAYE_MCP_SERVER_INFO },
  }
}

function invalidToolInput(message: string): ToolCallResult {
  return toolResult({ error: { code: 'invalid_args', message } }, true)
}

function workspaceFromArguments(
  args: unknown,
  required: boolean,
): { ok: true; workspaceId: string | null } | { ok: false; result: ToolCallResult } {
  if (args === undefined || args === null) {
    return required
      ? { ok: false, result: invalidToolInput('workspaceId is required.') }
      : { ok: true, workspaceId: null }
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, result: invalidToolInput('Tool arguments must be an object.') }
  }
  const record = args as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'workspaceId')) {
    return { ok: false, result: invalidToolInput('Only workspaceId is accepted by this tool version.') }
  }
  const workspaceId = record.workspaceId
  if (workspaceId === undefined || workspaceId === null) {
    return required
      ? { ok: false, result: invalidToolInput('workspaceId is required.') }
      : { ok: true, workspaceId: null }
  }
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    return { ok: false, result: invalidToolInput('workspaceId must be a non-empty string.') }
  }
  return { ok: true, workspaceId: workspaceId.trim() }
}

export async function callCayeMcpTool(
  founderUserId: string,
  name: string,
  args: unknown,
): Promise<ToolCallResult | null> {
  if (!CAYE_MCP_TOOLS.some((tool) => tool.name === name)) return null

  if (name === 'caye_context_snapshot') {
    const scope = workspaceFromArguments(args, false)
    if (!scope.ok) return scope.result
    const snapshot = await buildFounderContextSnapshot(founderUserId, scope.workspaceId)
    return toolResult({ snapshot }, false)
  }

  const capability = CAPABILITY_BY_TOOL[name as Exclude<ToolName, 'caye_context_snapshot'>]
  if (!capability) return null
  const scope = workspaceFromArguments(args, capability !== 'goals.list')
  if (!scope.ok) return scope.result

  const result: CapabilityResult = await invokeFounderReadCapability(founderUserId, {
    capability,
    version: 1,
    workspaceId: scope.workspaceId,
    args: {},
  })
  return toolResult({ result }, result.status === 'failed')
}

export function mcpDiscoveryResult() {
  return {
    supportedVersions: [CAYE_MCP_PROTOCOL_VERSION],
    capabilities: { tools: { listChanged: false } },
    instructions: 'Use Caye as the durable source of founder and business state. V0.1 tools are read-only.',
    ttlMs: 60_000,
    cacheScope: 'private',
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': CAYE_MCP_SERVER_INFO },
  }
}

export function mcpToolsListResult() {
  return {
    tools: CAYE_MCP_TOOLS,
    ttlMs: 60_000,
    cacheScope: 'private',
    resultType: 'complete',
    _meta: { 'io.modelcontextprotocol/serverInfo': CAYE_MCP_SERVER_INFO },
  }
}
