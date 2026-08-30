import 'server-only'

import type { Tool, ToolContext } from '../types'
import { invokeFounderResearchStartCapability } from '@/lib/capabilities/gateway'

type CapabilityToolContext = ToolContext & { founderUserId?: string }

type Args = {
  questionId: string
}

/**
 * Model-facing write adapter for the one canonical low-risk capability that
 * already has a dedicated founder gateway. Keep this as a separate registered
 * tool instead of smuggling a capability name through a generic dispatcher:
 * the tool's static risk classification must match every action it can perform.
 */
export const startCanonicalResearchTool: Tool<Args> = {
  name: 'start_canonical_research',
  description:
    'Founder-only low-risk Caye Direct action that starts an existing canonical research question by id. Use only after identifying the real question id through canonical research reads.',
  risk: 'low',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      questionId: { type: 'string', minLength: 1 },
    },
    required: ['questionId'],
    additionalProperties: false,
  },
  async execute(args, rawCtx) {
    if (rawCtx.channel !== 'dashboard') {
      return { ok: false, error: 'Canonical research start is currently available only in founder Caye Direct.' }
    }

    const ctx = rawCtx as CapabilityToolContext
    if (!ctx.founderUserId) {
      return {
        ok: false,
        error: 'Verified founder identity is unavailable on this conversation path. Research was not started.',
      }
    }

    const questionId = args.questionId?.trim()
    if (!questionId) return { ok: false, error: 'questionId must be a non-empty string.' }

    const result = await invokeFounderResearchStartCapability(ctx.founderUserId, {
      capability: 'research.start',
      version: 1,
      workspaceId: null,
      args: { questionId },
    })

    return result.status === 'failed'
      ? { ok: false, error: result.failure.message, data: result }
      : { ok: true, data: result }
  },
}
