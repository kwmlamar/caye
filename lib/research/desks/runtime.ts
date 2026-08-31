export type ResearchDeskMode = 'monitoring' | 'discovery'
export type ResearchDeskStatus = 'active' | 'inactive'
export type ResearchDeskCycleStatus = 'completed' | 'partial' | 'failed' | 'budget_exhausted' | 'unchanged'

export type ResearchDeskBudget = {
  maxDepth: number
  maxQueries: number
  maxSources: number
  timeoutMs: number
  maxTokens?: number
  maxCostUsd?: number
  maxRetries?: number
}

export type ResearchDeskDefinition = {
  id: string
  key: string
  programId: string
  workspaceId?: string | null
  domain: string
  standingMission: string
  standingQuestions: string[]
  cadence: { intervalMinutes: number; materialChangeIntervalMinutes?: number }
  explorationBudget: ResearchDeskBudget
  sourcePreferences: string[]
  geographicScope: string[]
  languageScope: string[]
  currentHypotheses: string[]
  lastSuccessfulResearch?: string | null
  nextScheduledInvestigation?: string | null
  confidenceThreshold: number
  relevanceThreshold: number
  escalationPolicy: Record<string, unknown>
  status: ResearchDeskStatus
}

export type ExistingDeskIntelligence = {
  fingerprint?: string | null
  recentQuestions: string[]
  currentClaims: Array<{ statement: string; confidence?: number | null; status?: string }>
  latestBrief?: { materialChanges?: unknown[]; unknowns?: unknown[] } | null
}

export type ResearchDeskQuestion = {
  id?: string
  question: string
  mode: ResearchDeskMode
  depth?: number
  rationale?: string
  parentQuestion?: string
}

export type ResearchDeskResearchResult = {
  question: ResearchDeskQuestion
  status: 'completed' | 'partial' | 'failed'
  sourceCount: number
  tokenCount?: number
  costUsd?: number
  fingerprint?: string | null
  claims?: Array<{ statement: string; confidence?: number | null; stance?: 'supports' | 'contradicts' | 'context' }>
  materialChanges?: string[]
  followUpQuestions?: ResearchDeskQuestion[]
  error?: string
}

export type ResearchDeskEvaluation = {
  novel: boolean
  material: boolean
  contradictory: boolean
  confidence: number
  relevance: number
  fingerprint?: string | null
  summary?: string
  followUpQuestions?: ResearchDeskQuestion[]
}

export type ResearchDeskBudgetUsage = {
  queries: number
  sources: number
  tokens: number
  costUsd: number
  depth: number
  retries: number
}

export type ResearchDeskCycle = {
  deskId: string
  wakeupKey: string
  status: ResearchDeskCycleStatus
  materialChange: boolean
  contradictoryEvidence: boolean
  summary: string
  startedAt: string
  completedAt: string
  nextScheduledInvestigation: string
  usage: ResearchDeskBudgetUsage
  investigatedQuestions: string[]
  errors: string[]
  fingerprint?: string | null
}

export type ResearchDeskCheckpoint = {
  processedQuestionKeys: string[]
  pendingQuestions: ResearchDeskQuestion[]
  results: ResearchDeskResearchResult[]
  usage: ResearchDeskBudgetUsage
}

export interface ResearchDeskStore {
  getDesk(deskId: string): Promise<ResearchDeskDefinition | null>
  reserveCycle(args: { deskId: string; wakeupKey: string; startedAt: string }): Promise<
    | { reserved: true; checkpoint?: ResearchDeskCheckpoint | null }
    | { reserved: false; cycle: ResearchDeskCycle }
  >
  saveCheckpoint(args: { deskId: string; wakeupKey: string; checkpoint: ResearchDeskCheckpoint }): Promise<void>
  completeCycle(cycle: ResearchDeskCycle): Promise<void>
  recordNoChange(args: {
    deskId: string
    wakeupKey: string
    at: string
    fingerprint?: string | null
    summary: string
  }): Promise<void>
}

export interface ResearchDeskIntelligenceReader {
  read(desk: ResearchDeskDefinition): Promise<ExistingDeskIntelligence>
}

export interface ResearchDeskQuestionPlanner {
  plan(args: {
    desk: ResearchDeskDefinition
    intelligence: ExistingDeskIntelligence
    mode: ResearchDeskMode
    remainingQueries: number
  }): Promise<ResearchDeskQuestion[]>
}

export interface ResearchDeskResearchExecutor {
  execute(args: { desk: ResearchDeskDefinition; question: ResearchDeskQuestion; attempt: number }): Promise<ResearchDeskResearchResult>
}

export interface ResearchDeskEvidenceEvaluator {
  evaluate(args: {
    desk: ResearchDeskDefinition
    intelligence: ExistingDeskIntelligence
    results: ResearchDeskResearchResult[]
  }): Promise<ResearchDeskEvaluation>
}

export interface ResearchDeskScheduler {
  schedule(args: { desk: ResearchDeskDefinition; at: string; reason: 'cadence' | 'material-change' | 'failure' }): Promise<void>
}

export type ResearchDeskRuntimeDependencies = {
  store: ResearchDeskStore
  intelligence: ResearchDeskIntelligenceReader
  planner: ResearchDeskQuestionPlanner
  executor: ResearchDeskResearchExecutor
  evaluator: ResearchDeskEvidenceEvaluator
  scheduler: ResearchDeskScheduler
  now?: () => Date
}

const EMPTY_USAGE = (): ResearchDeskBudgetUsage => ({ queries: 0, sources: 0, tokens: 0, costUsd: 0, depth: 0, retries: 0 })

function questionKey(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '')
}

function addMinutes(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString()
}

function budgetExceeded(usage: ResearchDeskBudgetUsage, budget: ResearchDeskBudget): boolean {
  return usage.queries >= budget.maxQueries ||
    usage.sources >= budget.maxSources ||
    (budget.maxTokens != null && usage.tokens >= budget.maxTokens) ||
    (budget.maxCostUsd != null && usage.costUsd >= budget.maxCostUsd)
}

function remainingQueries(usage: ResearchDeskBudgetUsage, budget: ResearchDeskBudget): number {
  return Math.max(0, budget.maxQueries - usage.queries)
}

function cappedQuestions(
  questions: ResearchDeskQuestion[],
  seen: Set<string>,
  recent: Set<string>,
  budget: ResearchDeskBudget,
  usage: ResearchDeskBudgetUsage,
): ResearchDeskQuestion[] {
  const available = remainingQueries(usage, budget)
  if (!available) return []
  const accepted: ResearchDeskQuestion[] = []
  for (const candidate of questions) {
    const depth = candidate.depth ?? 0
    const key = questionKey(candidate.question)
    if (!key || seen.has(key) || recent.has(key) || depth > budget.maxDepth) continue
    seen.add(key)
    accepted.push({ ...candidate, depth })
    if (accepted.length >= available) break
  }
  return accepted
}

async function executeWithRetry(
  deps: ResearchDeskRuntimeDependencies,
  desk: ResearchDeskDefinition,
  question: ResearchDeskQuestion,
  usage: ResearchDeskBudgetUsage,
): Promise<ResearchDeskResearchResult> {
  const maxRetries = Math.max(0, desk.explorationBudget.maxRetries ?? 0)
  let attempt = 0
  while (true) {
    try {
      return await deps.executor.execute({ desk, question, attempt })
    } catch (error) {
      if (attempt >= maxRetries) {
        return {
          question,
          status: 'failed',
          sourceCount: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      attempt += 1
      usage.retries += 1
    }
  }
}

/**
 * Generic standing-mission orchestration over Caye's canonical research engine.
 * This module deliberately does not fetch/search/persist claims itself. The
 * executor is the adapter to Research Runtime V1, so sources, runs, claims and
 * evidence keep their existing provenance and transactional semantics.
 */
export async function runResearchDeskCycle(
  input: { deskId: string; wakeupKey: string },
  deps: ResearchDeskRuntimeDependencies,
): Promise<ResearchDeskCycle> {
  const now = deps.now ?? (() => new Date())
  const started = now()
  const desk = await deps.store.getDesk(input.deskId)
  if (!desk) throw new Error(`Research desk ${input.deskId} does not exist`)
  if (desk.status !== 'active') throw new Error(`Research desk ${input.deskId} is inactive`)

  const reservation = await deps.store.reserveCycle({ deskId: desk.id, wakeupKey: input.wakeupKey, startedAt: started.toISOString() })
  if (!reservation.reserved) return reservation.cycle

  const checkpoint = reservation.checkpoint ?? {
    processedQuestionKeys: [],
    pendingQuestions: [],
    results: [],
    usage: EMPTY_USAGE(),
  }
  const usage = { ...checkpoint.usage }
  const results = [...checkpoint.results]
  const errors = results.flatMap((result) => result.error ? [result.error] : [])
  const seen = new Set(checkpoint.processedQuestionKeys)

  try {
    const existing = await deps.intelligence.read(desk)
    const recent = new Set(existing.recentQuestions.map(questionKey))

    let pending = checkpoint.pendingQuestions.length ? [...checkpoint.pendingQuestions] : []
    if (!pending.length && usage.queries === 0) {
      const monitor = await deps.planner.plan({ desk, intelligence: existing, mode: 'monitoring', remainingQueries: remainingQueries(usage, desk.explorationBudget) })
      pending.push(...cappedQuestions(monitor, seen, recent, desk.explorationBudget, usage))

      if (remainingQueries(usage, desk.explorationBudget) > 0) {
        const discovery = await deps.planner.plan({ desk, intelligence: existing, mode: 'discovery', remainingQueries: remainingQueries(usage, desk.explorationBudget) - pending.length })
        pending.push(...cappedQuestions(discovery, seen, recent, desk.explorationBudget, { ...usage, queries: usage.queries + pending.length }))
      }
    }

    const deadline = started.getTime() + desk.explorationBudget.timeoutMs
    while (pending.length && !budgetExceeded(usage, desk.explorationBudget)) {
      if (now().getTime() >= deadline) {
        errors.push('research desk timeout budget exhausted')
        break
      }
      const question = pending.shift()!
      if ((question.depth ?? 0) > desk.explorationBudget.maxDepth) continue

      usage.queries += 1
      usage.depth = Math.max(usage.depth, question.depth ?? 0)
      const result = await executeWithRetry(deps, desk, question, usage)
      results.push(result)
      usage.sources += Math.max(0, result.sourceCount)
      usage.tokens += Math.max(0, result.tokenCount ?? 0)
      usage.costUsd += Math.max(0, result.costUsd ?? 0)
      if (result.error) errors.push(result.error)

      const followUps = result.followUpQuestions ?? []
      pending.push(...cappedQuestions(followUps, seen, recent, desk.explorationBudget, usage))
      await deps.store.saveCheckpoint({
        deskId: desk.id,
        wakeupKey: input.wakeupKey,
        checkpoint: { processedQuestionKeys: [...seen], pendingQuestions: pending, results, usage },
      })
    }

    const evaluation = await deps.evaluator.evaluate({ desk, intelligence: existing, results })
    const meetsThreshold = evaluation.material &&
      evaluation.confidence >= desk.confidenceThreshold &&
      evaluation.relevance >= desk.relevanceThreshold
    const successful = results.filter((result) => result.status === 'completed').length
    const failed = results.filter((result) => result.status === 'failed').length
    const exhausted = budgetExceeded(usage, desk.explorationBudget) || now().getTime() >= deadline
    const changed = evaluation.novel || evaluation.material || evaluation.contradictory

    let status: ResearchDeskCycleStatus
    if (!changed && failed === 0) status = 'unchanged'
    else if (exhausted && pending.length) status = 'budget_exhausted'
    else if (successful === 0 && failed > 0) status = 'failed'
    else if (failed > 0 || results.some((result) => result.status === 'partial')) status = 'partial'
    else status = 'completed'

    const scheduleReason = status === 'failed' ? 'failure' : meetsThreshold ? 'material-change' : 'cadence'
    const interval = scheduleReason === 'material-change'
      ? (desk.cadence.materialChangeIntervalMinutes ?? desk.cadence.intervalMinutes)
      : desk.cadence.intervalMinutes
    const nextScheduledInvestigation = addMinutes(now(), interval)
    await deps.scheduler.schedule({ desk, at: nextScheduledInvestigation, reason: scheduleReason })

    const cycle: ResearchDeskCycle = {
      deskId: desk.id,
      wakeupKey: input.wakeupKey,
      status,
      materialChange: evaluation.material,
      contradictoryEvidence: evaluation.contradictory,
      summary: evaluation.summary ?? (status === 'unchanged' ? 'No material change detected.' : 'Research desk cycle completed.'),
      startedAt: started.toISOString(),
      completedAt: now().toISOString(),
      nextScheduledInvestigation,
      usage,
      investigatedQuestions: results.map((result) => result.question.question),
      errors,
      fingerprint: evaluation.fingerprint ?? existing.fingerprint,
    }

    if (status === 'unchanged') {
      await deps.store.recordNoChange({
        deskId: desk.id,
        wakeupKey: input.wakeupKey,
        at: cycle.completedAt,
        fingerprint: cycle.fingerprint,
        summary: cycle.summary,
      })
    }
    await deps.store.completeCycle(cycle)
    return cycle
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(message)
    const nextScheduledInvestigation = addMinutes(now(), desk.cadence.intervalMinutes)
    await deps.scheduler.schedule({ desk, at: nextScheduledInvestigation, reason: 'failure' })
    const cycle: ResearchDeskCycle = {
      deskId: desk.id,
      wakeupKey: input.wakeupKey,
      status: results.length ? 'partial' : 'failed',
      materialChange: false,
      contradictoryEvidence: false,
      summary: message,
      startedAt: started.toISOString(),
      completedAt: now().toISOString(),
      nextScheduledInvestigation,
      usage,
      investigatedQuestions: results.map((result) => result.question.question),
      errors,
    }
    await deps.store.completeCycle(cycle)
    return cycle
  }
}
