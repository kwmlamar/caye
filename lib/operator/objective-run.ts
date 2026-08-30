import 'server-only'

export type Authority = 'read' | 'write_low' | 'write_high'
export type StepState = 'pending' | 'checking' | 'recovered' | 'running' | 'verified' | 'blocked' | 'failed' | 'replanned' | 'waiting'
export type BudgetReason = 'timeout' | 'transitions' | 'revisions'

export type StateCheck = {
  status: 'current' | 'changed' | 'wait'
  reason?: string
  evidence?: unknown
  resumeAfterMs?: number
}

export type Verification = {
  ok: boolean
  evidence?: unknown
  reason?: string
  indeterminate?: boolean
  retryAfterMs?: number
}

export type InterruptedRecovery = {
  status: 'verified' | 'retry_safe' | 'wait' | 'blocked'
  reason?: string
  evidence?: unknown
  resumeAfterMs?: number
}

export type ObjectiveStep<TContext> = {
  key: string
  authority: Authority
  maxAttempts?: number
  checkState?: (context: TContext) => Promise<StateCheck>
  recoverInterrupted?: (context: TContext) => Promise<InterruptedRecovery>
  execute: (context: TContext) => Promise<unknown>
  verify: (context: TContext, effect: unknown) => Promise<Verification>
}

export type ObjectiveEvent = {
  at: string
  step: string
  state: StepState
  attempt: number
  evidence?: unknown
  error?: string
}

export type ReplanRequest<TContext> = {
  context: TContext
  step: ObjectiveStep<TContext>
  reason: string
  evidence?: unknown
  previousRevision: number
  nextRevision: number
}

export type ReplanResult<TContext> = {
  context?: TContext
  steps?: ObjectiveStep<TContext>[]
  evidence?: unknown
}

export type ObjectiveRunResult = {
  status: 'completed' | 'blocked' | 'failed' | 'waiting' | 'budget_exhausted'
  events: ObjectiveEvent[]
  completedSteps: string[]
  blockedStep?: string
  transitionsUsed: number
  budgetReason?: BudgetReason
  planRevision: number
  resumeAt?: string
}

function waitingEvidence(effect: unknown, verification: Verification, resumeAt: string) {
  return {
    pendingEffect: effect,
    verificationEvidence: verification.evidence ?? null,
    reason: verification.reason ?? 'Verification is indeterminate',
    resumeAt,
  }
}

export async function runBoundedObjective<TContext>(input: {
  context: TContext
  steps: ObjectiveStep<TContext>[]
  allowedAuthority: ReadonlySet<Authority>
  completedSteps?: ReadonlySet<string>
  pendingEffects?: ReadonlyMap<string, unknown>
  interruptedSteps?: ReadonlySet<string>
  maxTransitions?: number
  transitionsAlreadyUsed?: number
  timeoutMs?: number
  planRevision?: number
  maxPlanRevisions?: number
  onReplan?: (request: ReplanRequest<TContext>) => Promise<ReplanResult<TContext>>
  onEvent?: (event: ObjectiveEvent) => Promise<void>
}): Promise<ObjectiveRunResult> {
  const maxTransitions = input.maxTransitions ?? 12
  const timeoutMs = input.timeoutMs ?? 45_000
  const maxPlanRevisions = Math.max(0, Math.min(input.maxPlanRevisions ?? 2, 10))
  const started = Date.now()
  const events: ObjectiveEvent[] = []
  const completedSteps = [...(input.completedSteps ?? new Set<string>())]
  const pendingEffects = new Map(input.pendingEffects ?? [])
  const interruptedSteps = new Set(input.interruptedSteps ?? [])
  let transitions = Math.max(0, input.transitionsAlreadyUsed ?? 0)
  let planRevision = Math.max(0, input.planRevision ?? 0)
  let context = input.context
  let steps = input.steps

  const finish = (
    status: ObjectiveRunResult['status'],
    blockedStep?: string,
    budgetReason?: BudgetReason,
    resumeAt?: string,
  ): ObjectiveRunResult => ({
    status,
    events,
    completedSteps,
    blockedStep,
    transitionsUsed: transitions,
    budgetReason,
    planRevision,
    resumeAt,
  })

  const exhausted = (stepKey: string): ObjectiveRunResult | null => {
    if (transitions >= maxTransitions) return finish('budget_exhausted', stepKey, 'transitions')
    if (Date.now() - started >= timeoutMs) return finish('budget_exhausted', stepKey, 'timeout')
    return null
  }

  const emit = async (event: ObjectiveEvent) => {
    events.push(event)
    await input.onEvent?.(event)
  }

  let index = 0
  while (index < steps.length) {
    const step = steps[index]
    if (completedSteps.includes(step.key)) {
      index++
      continue
    }

    const beforeStep = exhausted(step.key)
    if (beforeStep) return beforeStep

    if (!input.allowedAuthority.has(step.authority)) {
      await emit({ at: new Date().toISOString(), step: step.key, state: 'blocked', attempt: 0, error: `Authority ${step.authority} not granted` })
      return finish('blocked', step.key)
    }

    if (interruptedSteps.has(step.key)) {
      const beforeRecovery = exhausted(step.key)
      if (beforeRecovery) return beforeRecovery
      transitions++
      await emit({ at: new Date().toISOString(), step: step.key, state: 'checking', attempt: 0, evidence: { mode: 'recover_interrupted_attempt', planRevision } })
      if (!step.recoverInterrupted) {
        await emit({
          at: new Date().toISOString(),
          step: step.key,
          state: 'blocked',
          attempt: 0,
          error: 'A prior process died after this effect started; replay is forbidden until the workflow provides explicit reconciliation.',
        })
        return finish('blocked', step.key)
      }
      try {
        const recovery = await step.recoverInterrupted(context)
        if (recovery.status === 'verified') {
          await emit({ at: new Date().toISOString(), step: step.key, state: 'verified', attempt: 0, evidence: { recovery: recovery.evidence, reason: recovery.reason } })
          completedSteps.push(step.key)
          interruptedSteps.delete(step.key)
          index++
          continue
        }
        if (recovery.status === 'wait') {
          const resumeAt = new Date(Date.now() + Math.max(1_000, recovery.resumeAfterMs ?? 60_000)).toISOString()
          await emit({ at: new Date().toISOString(), step: step.key, state: 'waiting', attempt: 0, error: recovery.reason, evidence: { reason: recovery.reason, recoveryEvidence: recovery.evidence, interrupted: true, resumeAt } })
          return finish('waiting', step.key, undefined, resumeAt)
        }
        if (recovery.status === 'blocked') {
          await emit({ at: new Date().toISOString(), step: step.key, state: 'blocked', attempt: 0, error: recovery.reason ?? 'Interrupted effect could not be reconciled safely', evidence: recovery.evidence })
          return finish('blocked', step.key)
        }
        interruptedSteps.delete(step.key)
        await emit({
          at: new Date().toISOString(),
          step: step.key,
          state: 'recovered',
          attempt: 0,
          evidence: { mode: 'interrupted_retry_declared_safe', recoveryEvidence: recovery.evidence, reason: recovery.reason },
        })
      } catch (error) {
        const resumeAt = new Date(Date.now() + 60_000).toISOString()
        const reason = error instanceof Error ? error.message : String(error)
        await emit({ at: new Date().toISOString(), step: step.key, state: 'waiting', attempt: 0, error: reason, evidence: { reason, interrupted: true, resumeAt } })
        return finish('waiting', step.key, undefined, resumeAt)
      }
    }

    if (step.checkState) {
      transitions++
      await emit({ at: new Date().toISOString(), step: step.key, state: 'checking', attempt: 0, evidence: { planRevision } })
      let state: StateCheck
      try {
        state = await step.checkState(context)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await emit({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt: 0, error: `State re-evaluation failed: ${reason}` })
        return finish('failed', step.key)
      }

      if (state.status === 'wait') {
        const resumeAt = new Date(Date.now() + Math.max(1_000, state.resumeAfterMs ?? 60_000)).toISOString()
        await emit({ at: new Date().toISOString(), step: step.key, state: 'waiting', attempt: 0, evidence: { reason: state.reason, stateEvidence: state.evidence, resumeAt, planRevision } })
        return finish('waiting', step.key, undefined, resumeAt)
      }

      if (state.status === 'changed') {
        if (planRevision >= maxPlanRevisions) {
          await emit({ at: new Date().toISOString(), step: step.key, state: 'blocked', attempt: 0, error: `Plan revision budget exhausted after ${planRevision} revision(s)`, evidence: state.evidence })
          return finish('budget_exhausted', step.key, 'revisions')
        }
        if (!input.onReplan) {
          await emit({ at: new Date().toISOString(), step: step.key, state: 'blocked', attempt: 0, error: state.reason ?? 'Changed reality requires replanning', evidence: state.evidence })
          return finish('blocked', step.key)
        }

        const previousRevision = planRevision
        const nextRevision = previousRevision + 1
        let replanned: ReplanResult<TContext>
        try {
          replanned = await input.onReplan({
            context,
            step,
            reason: state.reason ?? 'Changed reality detected',
            evidence: state.evidence,
            previousRevision,
            nextRevision,
          })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          await emit({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt: 0, error: `Replanning failed: ${reason}`, evidence: state.evidence })
          return finish('failed', step.key)
        }
        planRevision = nextRevision
        context = replanned.context ?? context
        steps = replanned.steps ?? steps
        pendingEffects.delete(step.key)
        await emit({
          at: new Date().toISOString(),
          step: step.key,
          state: 'replanned',
          attempt: 0,
          evidence: {
            previousRevision,
            planRevision,
            reason: state.reason ?? 'Changed reality detected',
            stateEvidence: state.evidence,
            replanEvidence: replanned.evidence,
          },
        })
        index = 0
        continue
      }
    }

    if (pendingEffects.has(step.key)) {
      const beforeReconcile = exhausted(step.key)
      if (beforeReconcile) return beforeReconcile
      transitions++
      const effect = pendingEffects.get(step.key)
      await emit({ at: new Date().toISOString(), step: step.key, state: 'checking', attempt: 0, evidence: { mode: 'reconcile_pending_effect', planRevision } })
      try {
        const verification = await step.verify(context, effect)
        if (verification.ok) {
          await emit({ at: new Date().toISOString(), step: step.key, state: 'verified', attempt: 0, evidence: verification.evidence })
          completedSteps.push(step.key)
          pendingEffects.delete(step.key)
          index++
          continue
        }
        if (verification.indeterminate) {
          const resumeAt = new Date(Date.now() + Math.max(1_000, verification.retryAfterMs ?? 60_000)).toISOString()
          await emit({ at: new Date().toISOString(), step: step.key, state: 'waiting', attempt: 0, error: verification.reason, evidence: waitingEvidence(effect, verification, resumeAt) })
          return finish('waiting', step.key, undefined, resumeAt)
        }
        await emit({ at: new Date().toISOString(), step: step.key, state: 'blocked', attempt: 0, error: verification.reason ?? 'Previously attempted effect could not be reconciled safely', evidence: verification.evidence })
        return finish('blocked', step.key)
      } catch (error) {
        const resumeAt = new Date(Date.now() + 60_000).toISOString()
        const reason = error instanceof Error ? error.message : String(error)
        await emit({ at: new Date().toISOString(), step: step.key, state: 'waiting', attempt: 0, error: reason, evidence: { pendingEffect: effect, reason, resumeAt } })
        return finish('waiting', step.key, undefined, resumeAt)
      }
    }

    const attempts = Math.max(1, Math.min(step.maxAttempts ?? 1, 3))
    let lastError = 'Step failed without an error'
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const beforeAttempt = exhausted(step.key)
      if (beforeAttempt) return beforeAttempt

      transitions++
      await emit({ at: new Date().toISOString(), step: step.key, state: 'running', attempt, evidence: { planRevision } })
      try {
        const effect = await step.execute(context)
        const verification = await step.verify(context, effect)
        if (verification.ok) {
          await emit({ at: new Date().toISOString(), step: step.key, state: 'verified', attempt, evidence: verification.evidence })
          completedSteps.push(step.key)
          lastError = ''
          break
        }
        if (verification.indeterminate) {
          const resumeAt = new Date(Date.now() + Math.max(1_000, verification.retryAfterMs ?? 60_000)).toISOString()
          await emit({ at: new Date().toISOString(), step: step.key, state: 'waiting', attempt, error: verification.reason, evidence: waitingEvidence(effect, verification, resumeAt) })
          return finish('waiting', step.key, undefined, resumeAt)
        }
        lastError = verification.reason ?? 'Side effect could not be verified'
        await emit({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt, error: lastError, evidence: verification.evidence })
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await emit({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt, error: lastError })
      }
    }
    if (lastError) return finish('failed', step.key)
    index++
  }

  return finish('completed')
}
