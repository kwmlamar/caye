import 'server-only'

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CapabilityExecutionContext,
  CapabilityResult,
  RegisteredCapability,
} from '@/lib/capabilities/types'
import {
  runBoundedObjective,
  type Authority,
  type ObjectiveEvent,
  type ObjectiveRunResult,
  type ObjectiveStep,
  type ReplanResult,
  type Verification,
} from './objective-run'
import {
  finalizeObjectiveRun,
  openOrResumeObjectiveRun,
  persistObjectiveEvent,
} from './objective-store'

export type ObjectiveObservation = {
  /** Stable semantic state only. Do not include wall-clock timestamps unless they are materially relevant. */
  state: unknown
  evidence?: unknown
  observedAt?: string
  freshUntil?: string | null
}

export type ObjectiveAuthorityDecision =
  | { status: 'authorized'; evidence?: unknown }
  | {
      status: 'decision_required'
      decisionId?: string | null
      decisionOwner?: string | null
      reason: string
      evidence?: unknown
      retryAfterMs?: number
    }
  | {
      status: 'unreachable'
      decisionId?: string | null
      decisionOwner?: string | null
      reason: string
      evidence?: unknown
      retryAfterMs?: number
    }
  | { status: 'denied'; reason: string; evidence?: unknown }

export type ObjectiveAuthorityRouter<TContext> = (input: {
  context: TContext
  step: ObjectiveStep<TContext>
  workspaceId: string | null
  objectiveKey: string
  runId: string
}) => Promise<ObjectiveAuthorityDecision>

export type ObjectivePlan<TContext> = {
  steps: ObjectiveStep<TContext>[]
  context: TContext
  evidence?: unknown
}

export type DurableObjectiveLoopResult = ObjectiveRunResult & {
  runId: string
  materialStateFingerprint: string
  suppressedUnchangedBlocker: boolean
  outcomeEvidence: unknown[]
}

type LoopMetadata = {
  materialStateFingerprint?: string
  lastWaitingFingerprint?: string
  lastWaitingStep?: string
  lastWaitingAt?: string
  planLineage?: Array<{
    from: number
    to: number
    reason: string
    at: string
  }>
  outcomeEvidence?: unknown[]
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)])
  )
}

export function objectiveFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

export function isObservationFresh(observation: ObjectiveObservation, nowMs = Date.now()): boolean {
  if (!observation.freshUntil) return true
  const freshUntil = Date.parse(observation.freshUntil)
  return Number.isFinite(freshUntil) && freshUntil >= nowMs
}

function eventOutcomeEvidence(events: ObjectiveEvent[]): unknown[] {
  return events
    .filter((event) => event.state === 'verified' || event.state === 'replanned' || event.state === 'blocked' || event.state === 'failed')
    .map((event) => ({
      at: event.at,
      step: event.step,
      state: event.state,
      attempt: event.attempt,
      evidence: event.evidence ?? null,
      error: event.error ?? null,
    }))
}

function waitingFingerprint(event: ObjectiveEvent | undefined, materialStateFingerprint: string): string | null {
  if (!event || event.state !== 'waiting') return null
  return objectiveFingerprint({
    step: event.step,
    reason: event.error ?? null,
    evidence: event.evidence ?? null,
    materialStateFingerprint,
  })
}

function readLoopMetadata(metadata: Record<string, unknown>): LoopMetadata {
  const loop = metadata.objectiveLoop
  if (!loop || typeof loop !== 'object') return {}
  return loop as LoopMetadata
}

function authorityWaitVerification(decision: Exclude<ObjectiveAuthorityDecision, { status: 'authorized' | 'denied' }>): Verification {
  return {
    ok: false,
    indeterminate: true,
    retryAfterMs: Math.max(1_000, decision.retryAfterMs ?? 60_000),
    reason: decision.reason,
    evidence: {
      authorityBoundary: decision.status,
      decisionId: decision.decisionId ?? null,
      decisionOwner: decision.decisionOwner ?? null,
      authorityEvidence: decision.evidence ?? null,
    },
  }
}

function wrapAuthorityBoundary<TContext>(input: {
  step: ObjectiveStep<TContext>
  router: ObjectiveAuthorityRouter<TContext>
  context: TContext
  workspaceId: string | null
  objectiveKey: string
  runId: string
}): ObjectiveStep<TContext> {
  if (input.step.authority !== 'write_high') return input.step

  let authorized = false
  let authorityDecision: ObjectiveAuthorityDecision | null = null
  const originalCheck = input.step.checkState
  const originalExecute = input.step.execute

  return {
    ...input.step,
    checkState: async (context) => {
      authorityDecision = await input.router({
        context,
        step: input.step,
        workspaceId: input.workspaceId,
        objectiveKey: input.objectiveKey,
        runId: input.runId,
      })
      if (authorityDecision.status === 'authorized') {
        authorized = true
        return originalCheck ? originalCheck(context) : { status: 'current' as const, evidence: authorityDecision.evidence }
      }
      if (authorityDecision.status === 'denied') {
        return {
          status: 'wait' as const,
          reason: authorityDecision.reason,
          evidence: {
            authorityBoundary: 'denied',
            authorityEvidence: authorityDecision.evidence ?? null,
          },
          resumeAfterMs: 24 * 60 * 60_000,
        }
      }
      return {
        status: 'wait' as const,
        reason: authorityDecision.reason,
        evidence: {
          authorityBoundary: authorityDecision.status,
          decisionId: authorityDecision.decisionId ?? null,
          decisionOwner: authorityDecision.decisionOwner ?? null,
          authorityEvidence: authorityDecision.evidence ?? null,
        },
        resumeAfterMs: Math.max(1_000, authorityDecision.retryAfterMs ?? 60_000),
      }
    },
    execute: async (context) => {
      if (!authorized) {
        throw new Error('Consequential objective step reached execution without canonical authority authorization')
      }
      return originalExecute(context)
    },
    verify: async (context, effect) => {
      if (authorityDecision && authorityDecision.status !== 'authorized' && authorityDecision.status !== 'denied') {
        return authorityWaitVerification(authorityDecision)
      }
      return input.step.verify(context, effect)
    },
  }
}

export function capabilityObjectiveStep<TArgs, TResult>(input: {
  key: string
  capability: RegisteredCapability<TArgs, TResult>
  args: TArgs
  capabilityContext: CapabilityExecutionContext
  /** Required for write capabilities. An executionRef alone is not independent effect verification. */
  verifyWrite?: (result: CapabilityResult<TResult>) => Promise<Verification>
  maxAttempts?: number
}): ObjectiveStep<Record<string, never>> {
  const risk = input.capability.manifest.risk
  const authority: Authority = risk === 'read_only' ? 'read' : risk === 'low' ? 'write_low' : 'write_high'

  return {
    key: input.key,
    authority,
    maxAttempts: input.maxAttempts ?? 1,
    execute: async () => input.capability.execute(input.args, input.capabilityContext),
    verify: async (_context, rawResult) => {
      const result = rawResult as CapabilityResult<TResult>
      if (result.status === 'failed') {
        return {
          ok: false,
          reason: result.failure.message,
          evidence: { capability: input.capability.manifest.name, result },
        }
      }
      if (risk === 'read_only') {
        return {
          ok: result.status === 'observed' || result.status === 'inferred',
          reason: result.status === 'observed' || result.status === 'inferred' ? undefined : `Read capability returned ${result.status}`,
          evidence: { capability: input.capability.manifest.name, result },
        }
      }
      if (!input.verifyWrite) {
        return {
          ok: false,
          indeterminate: true,
          retryAfterMs: 60_000,
          reason: 'Write capability executed or staged without an independent objective verifier',
          evidence: { capability: input.capability.manifest.name, result },
        }
      }
      return input.verifyWrite(result)
    },
  }
}

/**
 * Canonical durable orchestration around runBoundedObjective.
 * This function deliberately owns no execution FSM. The existing bounded runner
 * remains the only component that advances steps; this layer provides durable
 * perception, wake suppression, capability composition, authority routing, and
 * outcome/plan-lineage persistence around it.
 */
export async function runDurableObjectiveLoop<TContext>(input: {
  supabase: SupabaseClient
  objectiveKey: string
  planVersion: string
  scopeKind: 'workspace' | 'founder'
  workspaceId: string | null
  actorKey: string
  maxTransitions: number
  maxPlanRevisions?: number
  timeoutMs: number
  maxRunAgeMs: number
  observe: () => Promise<ObjectiveObservation>
  plan: (input: {
    observation: ObjectiveObservation
    materialStateFingerprint: string
    materialChanged: boolean
    previousMaterialStateFingerprint: string | null
    planRevision: number
  }) => Promise<ObjectivePlan<TContext>>
  replan?: (input: {
    context: TContext
    observation: ObjectiveObservation
    step: ObjectiveStep<TContext>
    reason: string
    evidence?: unknown
    previousRevision: number
    nextRevision: number
  }) => Promise<ReplanResult<TContext>>
  authorityRouter?: ObjectiveAuthorityRouter<TContext>
  metadata?: Record<string, unknown>
}): Promise<DurableObjectiveLoopResult> {
  const observation = await input.observe()
  const materialStateFingerprint = objectiveFingerprint(observation.state)
  const durable = await openOrResumeObjectiveRun({
    supabase: input.supabase,
    objectiveKey: input.objectiveKey,
    planVersion: input.planVersion,
    scopeKind: input.scopeKind,
    workspaceId: input.workspaceId,
    actorKey: input.actorKey,
    maxTransitions: input.maxTransitions,
    maxPlanRevisions: input.maxPlanRevisions,
    timeoutMs: input.timeoutMs,
    maxRunAgeMs: input.maxRunAgeMs,
    metadata: input.metadata,
  })

  const existingLoop = readLoopMetadata(durable.metadata)
  const previousMaterialStateFingerprint = existingLoop.materialStateFingerprint ?? null
  const materialChanged = previousMaterialStateFingerprint !== null && previousMaterialStateFingerprint !== materialStateFingerprint
  const storedResumeAt = typeof durable.metadata.resumeAt === 'string' ? durable.metadata.resumeAt : null
  const retryDue = !storedResumeAt || Date.parse(storedResumeAt) <= Date.now()
  const sameBlockedReality =
    !materialChanged &&
    existingLoop.lastWaitingFingerprint &&
    existingLoop.lastWaitingStep &&
    !retryDue

  if (sameBlockedReality) {
    const event: ObjectiveEvent = {
      at: new Date().toISOString(),
      step: existingLoop.lastWaitingStep!,
      state: 'waiting',
      attempt: 0,
      evidence: {
        suppressedUnchangedBlocker: true,
        materialStateFingerprint,
        previousWaitingFingerprint: existingLoop.lastWaitingFingerprint,
        resumeAt: storedResumeAt,
      },
      error: 'Unchanged blocker and material state; redundant objective work suppressed until wake condition or bounded retry.',
    }
    await persistObjectiveEvent(input.supabase, durable.runId, durable.runnerToken, input.timeoutMs, event)
    const result: ObjectiveRunResult = {
      status: 'waiting',
      events: [event],
      completedSteps: [...durable.completedSteps],
      blockedStep: existingLoop.lastWaitingStep!,
      transitionsUsed: durable.transitionsUsed,
      planRevision: durable.planRevision,
      resumeAt: storedResumeAt ?? undefined,
    }
    await finalizeObjectiveRun(input.supabase, durable.runId, durable.runnerToken, result, {
      ...durable.metadata,
      objectiveLoop: {
        ...existingLoop,
        materialStateFingerprint,
      },
    })
    return {
      runId: durable.runId,
      materialStateFingerprint,
      suppressedUnchangedBlocker: true,
      outcomeEvidence: existingLoop.outcomeEvidence ?? [],
      ...result,
    }
  }

  if (!isObservationFresh(observation)) {
    const resumeAt = new Date(Date.now() + 60_000).toISOString()
    const event: ObjectiveEvent = {
      at: new Date().toISOString(),
      step: '__perception__',
      state: 'waiting',
      attempt: 0,
      evidence: {
        staleEvidence: true,
        observedAt: observation.observedAt ?? null,
        freshUntil: observation.freshUntil ?? null,
        materialStateFingerprint,
        resumeAt,
      },
      error: 'Objective perception is stale; consequential reasoning/execution is suspended until fresh evidence is available.',
    }
    await persistObjectiveEvent(input.supabase, durable.runId, durable.runnerToken, input.timeoutMs, event)
    const result: ObjectiveRunResult = {
      status: 'waiting',
      events: [event],
      completedSteps: [...durable.completedSteps],
      blockedStep: '__perception__',
      transitionsUsed: durable.transitionsUsed,
      planRevision: durable.planRevision,
      resumeAt,
    }
    const waitFingerprint = waitingFingerprint(event, materialStateFingerprint)
    await finalizeObjectiveRun(input.supabase, durable.runId, durable.runnerToken, result, {
      ...durable.metadata,
      objectiveLoop: {
        ...existingLoop,
        materialStateFingerprint,
        lastWaitingFingerprint: waitFingerprint ?? undefined,
        lastWaitingStep: '__perception__',
        lastWaitingAt: event.at,
      },
    })
    return {
      runId: durable.runId,
      materialStateFingerprint,
      suppressedUnchangedBlocker: false,
      outcomeEvidence: existingLoop.outcomeEvidence ?? [],
      ...result,
    }
  }

  const planned = await input.plan({
    observation,
    materialStateFingerprint,
    materialChanged,
    previousMaterialStateFingerprint,
    planRevision: durable.planRevision,
  })

  const highRiskSteps = planned.steps.filter((step) => step.authority === 'write_high')
  const allowedAuthority = new Set<Authority>(['read', 'write_low'])
  let steps = planned.steps
  if (highRiskSteps.length > 0 && input.authorityRouter) {
    allowedAuthority.add('write_high')
    steps = planned.steps.map((step) => wrapAuthorityBoundary({
      step,
      router: input.authorityRouter!,
      context: planned.context,
      workspaceId: input.workspaceId,
      objectiveKey: input.objectiveKey,
      runId: durable.runId,
    }))
  }

  const result = await runBoundedObjective({
    context: planned.context,
    steps,
    allowedAuthority,
    completedSteps: durable.completedSteps,
    pendingEffects: durable.pendingEffects,
    interruptedSteps: durable.interruptedSteps,
    maxTransitions: durable.maxTransitions,
    transitionsAlreadyUsed: durable.transitionsUsed,
    timeoutMs: input.timeoutMs,
    planRevision: durable.planRevision,
    maxPlanRevisions: durable.maxPlanRevisions,
    onReplan: input.replan
      ? (request) => input.replan!({
          ...request,
          observation,
        })
      : undefined,
    onEvent: (event) => persistObjectiveEvent(input.supabase, durable.runId, durable.runnerToken, input.timeoutMs, event),
  })

  const priorLineage = existingLoop.planLineage ?? []
  const newLineage = result.events
    .filter((event) => event.state === 'replanned')
    .map((event) => {
      const evidence = event.evidence as Record<string, unknown> | undefined
      return {
        from: Number(evidence?.previousRevision ?? Math.max(0, result.planRevision - 1)),
        to: Number(evidence?.planRevision ?? result.planRevision),
        reason: String(evidence?.reason ?? event.error ?? 'material reality changed'),
        at: event.at,
      }
    })
  const outcomeEvidence = [...(existingLoop.outcomeEvidence ?? []), ...eventOutcomeEvidence(result.events)].slice(-100)
  const lastWaiting = [...result.events].reverse().find((event) => event.state === 'waiting')
  const lastWaitingFingerprint = waitingFingerprint(lastWaiting, materialStateFingerprint)

  await finalizeObjectiveRun(input.supabase, durable.runId, durable.runnerToken, result, {
    ...durable.metadata,
    ...input.metadata,
    observationEvidence: observation.evidence ?? null,
    planEvidence: planned.evidence ?? null,
    objectiveLoop: {
      materialStateFingerprint,
      lastWaitingFingerprint: lastWaitingFingerprint ?? undefined,
      lastWaitingStep: lastWaiting?.step,
      lastWaitingAt: lastWaiting?.at,
      planLineage: [...priorLineage, ...newLineage].slice(-50),
      outcomeEvidence,
    } satisfies LoopMetadata,
  })

  return {
    runId: durable.runId,
    materialStateFingerprint,
    suppressedUnchangedBlocker: false,
    outcomeEvidence,
    ...result,
  }
}
