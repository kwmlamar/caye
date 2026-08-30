import 'server-only'

export type Authority = 'read' | 'write_low' | 'write_high'
export type StepState = 'pending' | 'running' | 'verified' | 'blocked' | 'failed'
export type BudgetReason = 'timeout' | 'transitions'

export type ObjectiveStep<TContext> = {
  key: string
  authority: Authority
  maxAttempts?: number
  execute: (context: TContext) => Promise<unknown>
  verify: (context: TContext, effect: unknown) => Promise<{ ok: boolean; evidence?: unknown; reason?: string }>
}

export type ObjectiveEvent = {
  at: string
  step: string
  state: StepState
  attempt: number
  evidence?: unknown
  error?: string
}

export type ObjectiveRunResult = {
  status: 'completed' | 'blocked' | 'failed' | 'budget_exhausted'
  events: ObjectiveEvent[]
  completedSteps: string[]
  blockedStep?: string
  transitionsUsed: number
  budgetReason?: BudgetReason
}

export async function runBoundedObjective<TContext>(input: {
  context: TContext
  steps: ObjectiveStep<TContext>[]
  allowedAuthority: ReadonlySet<Authority>
  completedSteps?: ReadonlySet<string>
  maxTransitions?: number
  transitionsAlreadyUsed?: number
  timeoutMs?: number
  onEvent?: (event: ObjectiveEvent) => Promise<void>
}): Promise<ObjectiveRunResult> {
  const maxTransitions = input.maxTransitions ?? 12
  const timeoutMs = input.timeoutMs ?? 45_000
  const started = Date.now()
  const events: ObjectiveEvent[] = []
  const completedSteps = [...(input.completedSteps ?? new Set<string>())]
  let transitions = Math.max(0, input.transitionsAlreadyUsed ?? 0)

  const finish = (
    status: ObjectiveRunResult['status'],
    blockedStep?: string,
    budgetReason?: BudgetReason,
  ): ObjectiveRunResult => ({
    status,
    events,
    completedSteps,
    blockedStep,
    transitionsUsed: transitions,
    budgetReason,
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

  for (const step of input.steps) {
    if (completedSteps.includes(step.key)) continue

    const beforeStep = exhausted(step.key)
    if (beforeStep) return beforeStep

    if (!input.allowedAuthority.has(step.authority)) {
      await emit({ at: new Date().toISOString(), step: step.key, state: 'blocked', attempt: 0, error: `Authority ${step.authority} not granted` })
      return finish('blocked', step.key)
    }

    const attempts = Math.max(1, Math.min(step.maxAttempts ?? 1, 3))
    let lastError = 'Step failed without an error'
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const beforeAttempt = exhausted(step.key)
      if (beforeAttempt) return beforeAttempt

      transitions++
      await emit({ at: new Date().toISOString(), step: step.key, state: 'running', attempt })
      try {
        const effect = await step.execute(input.context)
        const verification = await step.verify(input.context, effect)
        if (verification.ok) {
          await emit({ at: new Date().toISOString(), step: step.key, state: 'verified', attempt, evidence: verification.evidence })
          completedSteps.push(step.key)
          lastError = ''
          break
        }
        lastError = verification.reason ?? 'Side effect could not be verified'
        await emit({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt, error: lastError, evidence: verification.evidence })
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        await emit({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt, error: lastError })
      }
    }
    if (lastError) return finish('failed', step.key)
  }

  return finish('completed')
}
