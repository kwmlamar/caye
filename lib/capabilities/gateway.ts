import 'server-only'

import { cayeCapabilityRegistry } from './catalog'
import { capabilityManifest, getRegisteredCapability } from './registry'
import type {
  CapabilityExecutionContext,
  CapabilityName,
  CapabilityResult,
} from './types'

export type FounderCapabilityInvocationInput = {
  capability: string
  version: number
  workspaceId: string | null
  /** Only accepted by capabilities that declare a canonical id-scoped selector (e.g. property.snapshot). */
  propertyId?: string
  args?: unknown
}

export type FounderResearchStartInput = {
  capability: 'research.start'
  version: 1
  workspaceId: null
  args: { questionId: string }
}

/**
 * Capabilities that resolve their own canonical scope from an explicit, founder-
 * visible id rather than from context.scope.workspaceId. Adding a capability here
 * is a deliberate, narrow exception to the zero-argument default below — not a
 * generic args passthrough.
 */
const PROPERTY_ID_SCOPED_CAPABILITIES = new Set<CapabilityName>(['property.snapshot'])

/**
 * Read capabilities that deliberately accept structured reasoning inputs. This is
 * an explicit allowlist so the founder read gateway does not become an arbitrary
 * argument passthrough as new capabilities are added.
 */
const STRUCTURED_ARG_READ_CAPABILITIES = new Set<CapabilityName>(['engineering.decision.analyze'])

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

async function invokeValidatedCapability<TArgs>(
  capability: NonNullable<ReturnType<typeof getRegisteredCapability>>,
  args: TArgs,
  context: CapabilityExecutionContext,
): Promise<CapabilityResult> {
  const execute = capability.execute as unknown as (
    validatedArgs: TArgs,
    validatedContext: CapabilityExecutionContext,
  ) => Promise<CapabilityResult>
  return execute(args, context)
}

/**
 * Server-side invocation boundary for the founder gateway.
 *
 * The authenticated user id and workspace scope are supplied by trusted server
 * code, never by the model as part of the capability args. This read gateway
 * remains read-only; staged writes use a separate, explicit boundary below.
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

  const capability = getRegisteredCapability(cayeCapabilityRegistry, input.capability as CapabilityName)
  if (!capability) return failed('not_found', 'Capability not found.')
  if (capability.manifest.version !== input.version) {
    return failed('invalid_args', 'Unsupported capability version.')
  }
  if (capability.manifest.access !== 'read' || capability.manifest.risk !== 'read_only') {
    return failed('unavailable', 'This gateway only exposes read-only capabilities.')
  }

  const isPropertyIdScoped = PROPERTY_ID_SCOPED_CAPABILITIES.has(capability.manifest.name)
  const acceptsStructuredArgs = STRUCTURED_ARG_READ_CAPABILITIES.has(capability.manifest.name)
  let executeArgs: unknown
  if (isPropertyIdScoped) {
    if (typeof input.propertyId !== 'string' || input.propertyId.trim().length === 0) {
      return failed('invalid_args', `${capability.manifest.name} requires a non-empty propertyId.`)
    }
    if (!emptyArgs(input.args)) {
      return failed('invalid_args', 'This capability version does not accept additional arguments.')
    }
    executeArgs = { propertyId: input.propertyId.trim() }
  } else if (acceptsStructuredArgs) {
    if (input.propertyId !== undefined) {
      return failed('invalid_args', 'This capability does not accept a propertyId.')
    }
    if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
      return failed('invalid_args', `${capability.manifest.name} requires structured arguments.`)
    }
    executeArgs = input.args
  } else {
    if (input.propertyId !== undefined) {
      return failed('invalid_args', 'This capability does not accept a propertyId.')
    }
    if (!emptyArgs(input.args)) {
      return failed('invalid_args', 'This capability version does not accept arguments.')
    }
    executeArgs = {}
  }

  try {
    return await invokeValidatedCapability(capability, executeArgs, {
      actor: { kind: 'founder', userId: authenticatedFounderUserId },
      scope: { workspaceId: input.workspaceId },
      caller: 'external_reasoner',
    })
  } catch {
    return failed('unavailable', 'Capability invocation failed.', true)
  }
}

/**
 * Deliberately narrow staged-write gateway. It can enqueue an existing research
 * question and nothing else. This is not a generic mutation passthrough.
 */
export async function invokeFounderResearchStartCapability(
  authenticatedFounderUserId: string,
  input: FounderResearchStartInput,
): Promise<CapabilityResult> {
  const capability = getRegisteredCapability(cayeCapabilityRegistry, 'research.start')
  if (!capability || capability.manifest.access !== 'write' || capability.manifest.risk !== 'low') {
    return failed('unavailable', 'Research start capability is unavailable.')
  }
  if (input.workspaceId !== null || input.capability !== 'research.start' || input.version !== 1) {
    return failed('invalid_args', 'Research start requires operator scope and version 1.')
  }
  const questionId = input.args?.questionId
  if (typeof questionId !== 'string' || !questionId.trim()) {
    return failed('invalid_args', 'questionId must be a non-empty string.')
  }
  try {
    return await invokeValidatedCapability(capability, { questionId: questionId.trim() }, {
      actor: { kind: 'founder', userId: authenticatedFounderUserId },
      scope: { workspaceId: null },
      caller: 'external_reasoner',
    })
  } catch {
    return failed('unavailable', 'Research run could not be queued.', true)
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
