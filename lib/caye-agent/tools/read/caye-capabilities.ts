import 'server-only'

import type { Tool, ToolContext } from '../types'
import { conversationalCapabilityManifest } from '@/lib/capabilities/control-plane'
import { invokeFounderReadCapability } from '@/lib/capabilities/gateway'

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
    'Founder-only read control-plane bridge for discovering and invoking canonical Caye read capabilities. Use this for goals, attention, engineering, growth, job search, research, perception, or property intelligence reads. Writes use the separate capability-write bridge so read-only continuation passes remain structurally read-only.',
  risk: 'read',
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
    const readable = manifest.filter((entry) => entry.access === 'read')
    if (args.action === 'discover') {
      return { ok: true, data: { capabilities: readable } }
    }

    if (!args.capability) return { ok: false, error: 'capability is required for invoke.' }
    const descriptor = manifest.find((entry) => entry.name === args.capability)
    if (!descriptor) {
      return { ok: false, error: `Capability '${args.capability}' is unavailable.` }
    }
    if (descriptor.access !== 'read') {
      return { ok: false, error: `Capability '${descriptor.name}' is a write capability and cannot execute through the read bridge.` }
    }
    if (!descriptor.available) {
      return { ok: false, error: descriptor.unavailableReason ?? 'Capability is unavailable.' }
    }

    const workspaceId = descriptor.scopeMode === 'operator' ? null : rawCtx.workspaceId
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
  },
}
