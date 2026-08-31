import { describe, expect, it, vi } from 'vitest'
import {
  runResearchDeskCycle,
  type ExistingDeskIntelligence,
  type ResearchDeskCheckpoint,
  type ResearchDeskCycle,
  type ResearchDeskDefinition,
  type ResearchDeskRuntimeDependencies,
  type ResearchDeskStore,
} from './runtime'

const desk = (id = 'desk-1', overrides: Partial<ResearchDeskDefinition> = {}): ResearchDeskDefinition => ({
  id,
  key: id,
  programId: `program-${id}`,
  workspaceId: `workspace-${id}`,
  domain: 'generic-domain',
  standingMission: 'Continuously understand material developments in this domain.',
  standingQuestions: ['What materially changed?'],
  cadence: { intervalMinutes: 360, materialChangeIntervalMinutes: 60 },
  explorationBudget: { maxDepth: 2, maxQueries: 4, maxSources: 12, timeoutMs: 60_000, maxTokens: 10_000, maxCostUsd: 2, maxRetries: 1 },
  sourcePreferences: ['primary'],
  geographicScope: ['global'],
  languageScope: ['English'],
  currentHypotheses: [],
  confidenceThreshold: 0.65,
  relevanceThreshold: 0.6,
  escalationPolicy: {},
  status: 'active',
  ...overrides,
})

function memoryStore(desks: ResearchDeskDefinition[], seeded?: { cycle?: ResearchDeskCycle; checkpoint?: ResearchDeskCheckpoint }) {
  const byId = new Map(desks.map((item) => [item.id, item]))
  const cycles = new Map<string, ResearchDeskCycle | { running: true; checkpoint?: ResearchDeskCheckpoint }>()
  if (seeded?.cycle) cycles.set(`${seeded.cycle.deskId}:${seeded.cycle.wakeupKey}`, seeded.cycle)
  if (seeded?.checkpoint) cycles.set(`${desks[0].id}:wake`, { running: true, checkpoint: seeded.checkpoint })
  const noChanges: string[] = []
  const store: ResearchDeskStore = {
    async getDesk(id) { return byId.get(id) ?? null },
    async reserveCycle({ deskId, wakeupKey }) {
      const key = `${deskId}:${wakeupKey}`
      const existing = cycles.get(key)
      if (existing && !('running' in existing)) return { reserved: false as const, cycle: existing }
      if (existing && 'running' in existing) return { reserved: true as const, checkpoint: existing.checkpoint }
      cycles.set(key, { running: true })
      return { reserved: true as const, checkpoint: null }
    },
    async saveCheckpoint({ deskId, wakeupKey, checkpoint }) { cycles.set(`${deskId}:${wakeupKey}`, { running: true, checkpoint }) },
    async completeCycle(cycle) { cycles.set(`${cycle.deskId}:${cycle.wakeupKey}`, cycle) },
    async recordNoChange({ deskId }) { noChanges.push(deskId) },
  }
  return { store, cycles, noChanges }
}

function dependencies(options: {
  desks?: ResearchDeskDefinition[]
  intelligence?: ExistingDeskIntelligence
  monitoring?: string[]
  discovery?: string[]
  result?: Partial<Awaited<ReturnType<ResearchDeskRuntimeDependencies['executor']['execute']>>>
  evaluation?: Partial<Awaited<ReturnType<ResearchDeskRuntimeDependencies['evaluator']['evaluate']>>>
  execute?: ResearchDeskRuntimeDependencies['executor']['execute']
  seeded?: { cycle?: ResearchDeskCycle; checkpoint?: ResearchDeskCheckpoint }
} = {}) {
  const desks = options.desks ?? [desk()]
  const memory = memoryStore(desks, options.seeded)
  const scheduled: Array<{ deskId: string; reason: string }> = []
  const executor = options.execute ?? vi.fn(async ({ question }) => ({
    question,
    status: 'completed' as const,
    sourceCount: 1,
    materialChanges: [],
    ...options.result,
  }))
  const deps: ResearchDeskRuntimeDependencies = {
    store: memory.store,
    intelligence: { read: vi.fn(async () => options.intelligence ?? { recentQuestions: [], currentClaims: [], latestBrief: null }) },
    planner: { plan: vi.fn(async ({ mode }) => (mode === 'monitoring' ? options.monitoring ?? ['monitor change'] : options.discovery ?? ['discover unknown development']).map((question) => ({ question, mode, depth: 0 }))) },
    executor,
    evaluator: { evaluate: vi.fn(async () => ({
      novel: false,
      material: false,
      contradictory: false,
      confidence: 0.5,
      relevance: 0.5,
      summary: 'No material change detected.',
      ...options.evaluation,
    })) },
    scheduler: { schedule: vi.fn(async ({ desk: item, reason }) => { scheduled.push({ deskId: item.id, reason }) }) },
    now: () => new Date('2026-08-31T05:00:00.000Z'),
  }
  return { deps, memory, scheduled, executor }
}

describe('runResearchDeskCycle', () => {
  it('records an unchanged world state cheaply and stops', async () => {
    const { deps, memory } = dependencies({ discovery: [] })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle.status).toBe('unchanged')
    expect(memory.noChanges).toEqual(['desk-1'])
    expect(cycle.materialChange).toBe(false)
  })

  it('recognizes a material new development and accelerates reassessment', async () => {
    const { deps, scheduled } = dependencies({ evaluation: { novel: true, material: true, confidence: 0.9, relevance: 0.92, summary: 'Material development.' } })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle.status).toBe('completed')
    expect(cycle.materialChange).toBe(true)
    expect(scheduled).toContainEqual({ deskId: 'desk-1', reason: 'material-change' })
  })

  it('preserves contradictory evidence as a material cycle signal', async () => {
    const { deps } = dependencies({ evaluation: { novel: true, material: true, contradictory: true, confidence: 0.8, relevance: 0.8 } })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle.contradictoryEvidence).toBe(true)
    expect(cycle.status).toBe('completed')
  })

  it('records research failure and schedules a retry wakeup', async () => {
    const { deps, scheduled } = dependencies({ execute: vi.fn(async () => { throw new Error('provider unavailable') }) })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle.status).toBe('failed')
    expect(cycle.errors.some((error) => error.includes('provider unavailable'))).toBe(true)
    expect(scheduled.at(-1)?.reason).toBe('failure')
  })

  it('keeps durable partial research instead of pretending the cycle failed wholly', async () => {
    let call = 0
    const { deps } = dependencies({ execute: vi.fn(async ({ question }) => {
      call += 1
      return call === 1
        ? { question, status: 'completed' as const, sourceCount: 2 }
        : { question, status: 'partial' as const, sourceCount: 1, error: 'one source failed' }
    }) })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle.status).toBe('partial')
    expect(cycle.usage.sources).toBe(3)
  })

  it('returns the prior cycle for duplicate scheduler execution without researching again', async () => {
    const prior: ResearchDeskCycle = {
      deskId: 'desk-1', wakeupKey: 'wake', status: 'unchanged', materialChange: false, contradictoryEvidence: false,
      summary: 'already ran', startedAt: '2026-08-31T04:00:00Z', completedAt: '2026-08-31T04:01:00Z', nextScheduledInvestigation: '2026-08-31T10:00:00Z',
      usage: { queries: 1, sources: 1, tokens: 0, costUsd: 0, depth: 0, retries: 0 }, investigatedQuestions: ['q'], errors: [],
    }
    const { deps, executor } = dependencies({ seeded: { cycle: prior } })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle).toEqual(prior)
    expect(executor).not.toHaveBeenCalled()
  })

  it('enforces exploration budget exhaustion without issuing excess queries', async () => {
    const limited = desk('desk-1', { explorationBudget: { maxDepth: 1, maxQueries: 1, maxSources: 2, timeoutMs: 60_000 } })
    const { deps, executor } = dependencies({ desks: [limited], monitoring: ['q1', 'q2', 'q3'], discovery: ['q4'] })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle.usage.queries).toBe(1)
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('resumes from a persisted checkpoint on restart/replay', async () => {
    const checkpoint: ResearchDeskCheckpoint = {
      processedQuestionKeys: ['first question', 'second question'],
      pendingQuestions: [{ question: 'second question', mode: 'discovery', depth: 1 }],
      results: [{ question: { question: 'first question', mode: 'monitoring', depth: 0 }, status: 'completed', sourceCount: 2 }],
      usage: { queries: 1, sources: 2, tokens: 0, costUsd: 0, depth: 0, retries: 0 },
    }
    const { deps, executor } = dependencies({ seeded: { checkpoint } })
    const cycle = await runResearchDeskCycle({ deskId: 'desk-1', wakeupKey: 'wake' }, deps)
    expect(cycle.investigatedQuestions).toEqual(['first question', 'second question'])
    expect(executor).toHaveBeenCalledTimes(1)
  })

  it('keeps desk state and scheduling isolated across desks', async () => {
    const desks = [desk('alpha'), desk('beta')]
    const { deps, scheduled } = dependencies({ desks })
    const alpha = await runResearchDeskCycle({ deskId: 'alpha', wakeupKey: 'same-wakeup' }, deps)
    const beta = await runResearchDeskCycle({ deskId: 'beta', wakeupKey: 'same-wakeup' }, deps)
    expect(alpha.deskId).toBe('alpha')
    expect(beta.deskId).toBe('beta')
    expect(scheduled.map((item) => item.deskId).sort()).toEqual(['alpha', 'beta'])
  })
})
