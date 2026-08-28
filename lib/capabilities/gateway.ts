import 'server-only'

import { cayeCapabilityRegistry } from './catalog'
import { capabilityManifest, getRegisteredCapability } from './registry'
import type { CapabilityName, CapabilityResult } from './types'

export type FounderCapabilityInvocationInput = {
  capability: string
  version: number
  workspaceId: string | null
  args?: unknown
}

export type FounderContextSnapshot = {
  actor: { kind: 'founder' }
  scope: { workspaceId: string | null }
  capabilities: ReturnType<typeof capabilityManifest>
  observations: {
    goals: CapabilityResult
    attention: CapabilityResult | null
    engineeringArtifacts: CapabilityResult | null
  }
}

function failed(code: 'not_found' | 'invalid_args' | 'unavailable', message: string, retryable = false): CapabilityResult {
  return {
    status: 'failed',
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code, message, retryable },
  }
}

function emptyArgs(args: unknown): args is Record<string, never> {
  if (args === undefined || args === null) return true
  if (typeof args !== 'object' || Array.isArray(args)) return false
  return Object.keys(args as Record<string, unknown>).length === 0
}

/**
 * Server-side invocation boundary for the founder gateway.
 *
 * The authenticated user id and workspace scope are supplied by trusted server
 * code, never by the model as part of the capability args. V0.1 deliberately
 * allows only read capabilities. Adding writes later requires a separate gate,
 * not a broadening of this function by accident.
 */
export async function invokeFounderReadCapability(
  authenticatedFounderUserId: string,
  input: FounderCapabilityInvocationInput,
): Promise<CapabilityResult> {
  if (input.version !== 1) {
    return failed('invalid_args', 'Unsupported capability version.')
  }
  if (input.workspaceId !== null && (!input.workspaceId || typeof input.workspaceId !== 'string')) {
    return failed('invalid_args', 'workspaceId must be a non-empty string or null.')
  }
  if (!emptyArgs(input.args)) {
    return failed('invalid_args', 'This capability version does not accept arguments.')
  }

  const capability = getRegisteredCapability(cayeCapabilityRegistry, input.capability as CapabilityName)
  if (!capability) return failed('not_found', 'Capability not found.')
  if (capability.manifest.version !== input.version) {
    return failed('invalid_args', 'Unsupported capability version.')
  }
  if (capability.manifest.access !== 'read' || capability.manifest.risk !== 'read_only') {
    return failed('unavailable', 'This gateway only exposes read-only capabilities.')
  }

  try {
    return await capability.execute({}, {
      actor: { kind: 'founder', userId: authenticatedFounderUserId },
      scope: { workspaceId: input.workspaceId },
      caller: 'external_reasoner',
    })
  } catch {
    return failed('unavailable', 'Capability invocation failed.', true)
  }
}

export function founderCapabilityManifest() {
  return capabilityManifest(cayeCapabilityRegistry)
}

/** Compact snapshot for a frontier reasoning layer entering a fresh session. */
export async function buildFounderContextSnapshot(
  authenticatedFounderUserId: string,
  workspaceId: string | null,
): Promise<FounderContextSnapshot> {
  const goals = await invokeFounderReadCapability(authenticatedFounderUserId, {
    capability: 'goals.list',
    version: 1,
    workspaceId,
  })

  const [attention, engineeringArtifacts] = workspaceId
    ? await Promise.all([
        invokeFounderReadCapability(authenticatedFounderUserId, {
          capability: 'attention.list',
          version: 1,
          workspaceId,
        }),
        invokeFounderReadCapability(authenticatedFounderUserId, {
          capability: 'engineering.artifacts.list',
          version: 1,
          workspaceId,
        }),
      ])
    : [null, null]

  return {
    actor: { kind: 'founder' },
    scope: { workspaceId },
    capabilities: founderCapabilityManifest(),
    observations: { goals, attention, engineeringArtifacts },
  }
}
