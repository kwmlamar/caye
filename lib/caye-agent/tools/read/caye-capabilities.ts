import 'server-only'

import type { Tool, ToolContext } from '../types'
import { conversationalCapabilityManifest } from '@/lib/capabilities/control-plane'
import {
  invokeFounderReadCapability,
  invokeFounderResearchStartCapability,
} from '@/lib/capabilities/gateway'

type CapabilityToolContext = ToolContext & { founderUserId?: string }

type Args = {
  action: 'discover' | 'invoke'
  capability?: string
  propertyId?: string
  args?: Record<string, unknown>
}

export const cayeCapabilitiesTool: Tool<Args> = {
  name: 'caye_capabilities',
  description:
    'Founder-only control-plane bridge for discovering and invoking canonical Caye capabilities. Use this when the founder expresses an objective that maps to goals, attention, engineering, growth, job search, research, or property intelligence. It preserves Caye capability authorization, scope, versioning, and structured results rather than reaching into subsystems directly.',
  // This bridge can invoke the bounded research.start write capability. Mark
  // the whole bridge low-risk so read-only continuation passes structurally
  // exclude it instead of relying on a prompt or per-call convention.
  risk: 'low',
  roles: ['founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['discover', 'invoke'] },
      capability: { type: 'string' },
      propertyId: { type: 'string' },
      args: { type: 'object', additionalProperties: true },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(args, rawCtx) {
    if (rawCtx.channel !== 'dashboard') {
      return { ok: false, error: 'The canonical capability bridge is currently available only in founder Caye Direct.' }
    }

    const ctx = rawCtx as CapabilityToolContext
    if (!ctx.founderUserId) {
      return {
        ok: false,
        error: 'Verified founder identity is unavailable on this conversation path. The capability was not invoked.',
      }
    }

    const manifest = conversationalCapabilityManifest()
    if (args.action === 'discover') {
      return { ok: true, data: { capabilities: manifest } }
    }

    if (!args.capability) return { ok: false, error: 'capability is required for invoke.' }
    const descriptor = manifest.find((entry) => entry.name === args.capability)
    if (!descriptor) {
      return {
        ok: false,
        error: `Capability '${args.capability}' is unavailable. Discover capabilities before choosing another path.`,
      }
    }

    if (!descriptor.available || descriptor.approvalRequirement === 'unavailable') {
      return { ok: false, error: descriptor.unavailableReason ?? 'Capability is unavailable.' }
    }

    if (descriptor.approvalRequirement === 'explicit_confirmation') {
      return {
        ok: false,
        error: `Capability '${descriptor.name}' requires explicit confirmation and is not executable through this bridge without the existing approval boundary.`,
      }
    }

    const workspaceId = descriptor.scopeMode === 'operator' ? null : rawCtx.workspaceId

    if (descriptor.access === 'read') {
      const result = await invokeFounderReadCapability(ctx.founderUserId, {
        capability: descriptor.name,
        version: descriptor.version,
        workspaceId,
        propertyId: args.propertyId,
        args: args.args,
      })
      return result.status === 'failed'
        ? { ok: false, error: result.failure.message, data: result }
        : { ok: true, data: result }
    }

    if (descriptor.name === 'research.start') {
      const questionId = args.args?.questionId
      if (typeof questionId !== 'string' || !questionId.trim()) {
        return { ok: false, error: 'research.start requires args.questionId.' }
      }
      const result = await invokeFounderResearchStartCapability(ctx.founderUserId, {
        capability: 'research.start',
        version: 1,
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
