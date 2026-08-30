import 'server-only'

import type { Tool, ToolContext } from '../types'
import { conversationalCapabilityManifest } from '@/lib/capabilities/control-plane'
import { invokeFounderResearchStartCapability } from '@/lib/capabilities/gateway'

type CapabilityToolContext = ToolContext & { founderUserId?: string }

type Args = {
  capability: string
  args?: Record<string, unknown>
}

export const cayeCapabilityWriteTool: Tool<Args> = {
  name: 'caye_capability_write',
  description:
    'Founder-only low-risk write bridge for canonical Caye capabilities that already have an authorized conversational adapter. This tool is structurally excluded from read-only continuation passes.',
  risk: 'low',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      capability: { type: 'string' },
      args: { type: 'object', additionalProperties: true },
    },
    required: ['capability'],
    additionalProperties: false,
  },
  async execute(args, rawCtx) {
    if (rawCtx.channel !== 'dashboard') {
      return { ok: false, error: 'The canonical capability write bridge is currently available only in founder Caye Direct.' }
    }

    const ctx = rawCtx as CapabilityToolContext
    if (!ctx.founderUserId) {
      return { ok: false, error: 'Verified founder identity is unavailable. Nothing was changed.' }
    }

    const descriptor = conversationalCapabilityManifest().find((entry) => entry.name === args.capability)
    if (!descriptor) return { ok: false, error: `Capability '${args.capability}' is unavailable.` }
    if (descriptor.access !== 'write') {
      return { ok: false, error: `Capability '${descriptor.name}' is read-only and cannot execute through the write bridge.` }
    }
    if (!descriptor.available || descriptor.approvalRequirement === 'unavailable') {
      return { ok: false, error: descriptor.unavailableReason ?? 'Capability is unavailable.' }
    }
    if (descriptor.approvalRequirement === 'explicit_confirmation') {
      return { ok: false, error: `Capability '${descriptor.name}' requires the existing explicit confirmation boundary and is not adapted here.` }
    }

    if (descriptor.name === 'research.start') {
      const questionId = args.args?.questionId
      if (typeof questionId !== 'string' || !questionId.trim()) {
        return { ok: false, error: 'research.start requires args.questionId.' }
      }
      const result = await invokeFounderResearchStartCapability(ctx.founderUserId, {
        capability: 'research.start',
        version: descriptor.version,
        workspaceId: null,
        args: { questionId: questionId.trim() },
      })
      return result.status === 'failed'
        ? { ok: false, error: result.failure.message, data: result }
        : { ok: true, data: result }
    }

    return {
      ok: false,
      error: `Write capability '${descriptor.name}' is registered but has no conversational execution adapter yet. Nothing was changed.`,
    }
  },
}
