import { BenchClock } from './clock'
import { BenchInvariantGate } from './gate'
import { computeQualityMetrics, computeQualityScore } from './scoring'
import type {
  BenchAdapter,
  BenchInputEvent,
  BenchReport,
  BenchScenario,
  BenchScenarioResult,
} from './types'

export interface BenchRunOptions {
  generatedAt?: string
}

export async function runBenchScenario(
  scenario: BenchScenario,
  adapter: BenchAdapter,
): Promise<BenchScenarioResult> {
  if (adapter.reset) await adapter.reset(scenario)
  const clock = new BenchClock(scenario.initialTime)
  const gate = new BenchInvariantGate()
  const events: BenchInputEvent[] = []
  const effects = [] as BenchScenarioResult['effects']
  const violations = [] as BenchScenarioResult['violations']
  const seed = scenario.seed ?? 1

  for (const event of scenario.events) {
    clock.advanceTo(event.at)
    gate.observeEvent(event)
    events.push(event)

    const produced = await adapter.handle(event, {
      workspaceId: scenario.workspaceId,
      now: clock.now(),
      seed,
      priorEvents: events.slice(0, -1),
      priorEffects: effects,
    })

    for (const effect of produced) {
      effects.push(effect)
      violations.push(...gate.evaluate(effect, scenario.workspaceId))
    }
  }

  const assertionResults = (scenario.assertions ?? []).map((assertion) => {
    try {
      const outcome = assertion.check({ scenario, events, effects })
      if (typeof outcome === 'boolean') {
        return { id: assertion.id, description: assertion.description, pass: outcome }
      }
      return { id: assertion.id, description: assertion.description, pass: outcome.pass, detail: outcome.detail }
    } catch (error) {
      return {
        id: assertion.id,
        description: assertion.description,
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  })

  const assertionPassRate = assertionResults.length === 0
    ? 1
    : assertionResults.filter((result) => result.pass).length / assertionResults.length
  const metrics = computeQualityMetrics(effects, assertionPassRate)
  const qualityScore = computeQualityScore(metrics)

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    adapter: adapter.name,
    startedAt: scenario.initialTime,
    finishedAt: clock.now(),
    eventsProcessed: events.length,
    effects,
    violations,
    assertions: assertionResults,
    metrics,
    qualityScore,
    passed: violations.length === 0 && assertionResults.every((result) => result.pass),
  }
}

export async function runCayeBench(
  scenarios: readonly BenchScenario[],
  adapter: BenchAdapter,
  options: BenchRunOptions = {},
): Promise<BenchReport> {
  const results: BenchScenarioResult[] = []
  for (const scenario of scenarios) results.push(await runBenchScenario(scenario, adapter))

  const hardInvariantFailures = results.reduce((sum, result) => sum + result.violations.length, 0)
  const scenarioPassRate = results.length === 0
    ? 1
    : results.filter((result) => result.passed).length / results.length
  const aggregateQualityScore = results.length === 0
    ? 100
    : Math.round((results.reduce((sum, result) => sum + result.qualityScore, 0) / results.length) * 10) / 10

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    adapter: adapter.name,
    scenarios: results,
    hardInvariantFailures,
    scenarioPassRate,
    aggregateQualityScore,
    passed: hardInvariantFailures === 0 && results.every((result) => result.passed),
  }
}
