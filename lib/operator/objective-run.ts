import 'server-only'

export type Authority = 'read' | 'write_low' | 'write_high'
export type StepState = 'pending' | 'running' | 'verified' | 'blocked' | 'failed'

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
}

export async function runBoundedObjective<TContext>(input: {
  context: TContext
  steps: ObjectiveStep<TContext>[]
  allowedAuthority: ReadonlySet<Authority>
  maxTransitions?: number
  timeoutMs?: number
}): Promise<ObjectiveRunResult> {
  const maxTransitions = input.maxTransitions ?? 12
  const timeoutMs = input.timeoutMs ?? 45_000
  const started = Date.now()
  const events: ObjectiveEvent[] = []
  const completedSteps: string[] = []
  let transitions = 0

  for (const step of input.steps) {
    if (Date.now() - started >= timeoutMs || transitions >= maxTransitions) {
      return { status: 'budget_exhausted', events, completedSteps, blockedStep: step.key }
    }
    if (!input.allowedAuthority.has(step.authority)) {
      events.push({ at: new Date().toISOString(), step: step.key, state: 'blocked', attempt: 0, error: `Authority ${step.authority} not granted` })
      return { status: 'blocked', events, completedSteps, blockedStep: step.key }
    }

    const attempts = Math.max(1, Math.min(step.maxAttempts ?? 1, 3))
    let lastError = 'Step failed without an error'
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (Date.now() - started >= timeoutMs || transitions >= maxTransitions) {
        return { status: 'budget_exhausted', events, completedSteps, blockedStep: step.key }
      }
      transitions++
      events.push({ at: new Date().toISOString(), step: step.key, state: 'running', attempt })
      try {
        const effect = await step.execute(input.context)
        const verification = await step.verify(input.context, effect)
        if (verification.ok) {
          events.push({ at: new Date().toISOString(), step: step.key, state: 'verified', attempt, evidence: verification.evidence })
          completedSteps.push(step.key)
          lastError = ''
          break
        }
        lastError = verification.reason ?? 'Side effect could not be verified'
        events.push({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt, error: lastError, evidence: verification.evidence })
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        events.push({ at: new Date().toISOString(), step: step.key, state: 'failed', attempt, error: lastError })
      }
    }
    if (lastError) return { status: 'failed', events, completedSteps, blockedStep: step.key }
  }

  return { status: 'completed', events, completedSteps }
}
