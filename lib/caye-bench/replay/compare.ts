import { createHash } from 'node:crypto'
import { BenchInvariantGate } from '../gate'
import { computeQualityMetrics, computeQualityScore } from '../scoring'
import type { BenchQualityMetrics, BenchScenarioResult, BenchViolation } from '../types'
import type { ReplayTrace } from './types'

/**
 * replay/compare.ts — historical vs. replay, without exact-response
 * snapshot testing.
 *
 * Preserves v1's own core principle instead of replacing it: hard
 * invariants are evaluated with the SAME `BenchInvariantGate`
 * (gate.ts, unmodified) against BOTH the historical record and the
 * replay run, and a safety regression is reported as its own, unmissable
 * top-level field — never folded into a blended score. Quality/behavior
 * deltas use the SAME `computeQualityMetrics`/`computeQualityScore`
 * (scoring.ts, unmodified) on both sides.
 *
 * "Historical behavior may itself have been wrong" (the task's own
 * instruction) is why historical effects go through the identical
 * invariant gate rather than being trusted as ground truth: a trace
 * whose OWN historicalEffects already violate a hard invariant is
 * explicitly representable — `historical.violations` — and `compare`
 * reports whether replay REPRODUCES, FIXES, or newly INTRODUCES each
 * one, rather than asserting historical output was correct by
 * definition.
 */

export interface BehaviorDelta {
  metric: keyof BenchQualityMetrics
  historical: number
  replay: number
  /** 'better'/'worse' account for which direction is actually good for
   *  this metric (e.g. fewer unnecessaryOperatorInterruptions is
   *  better; more usefulProactiveActions is better) — never a raw
   *  numeric increase/decrease read as good/bad by default. */
  direction: 'better' | 'worse' | 'same'
}

const LOWER_IS_BETTER: ReadonlySet<keyof BenchQualityMetrics> = new Set([
  'unnecessaryOperatorInterruptions',
  'uselessProactiveActions',
  'failedConsequentialActions',
  'ungroundedClaims',
])

const COMPARED_METRICS: ReadonlyArray<keyof BenchQualityMetrics> = [
  'operatorInterruptions',
  'unnecessaryOperatorInterruptions',
  'usefulProactiveActions',
  'uselessProactiveActions',
  'completedConsequentialActions',
  'failedConsequentialActions',
  'evidenceBackedClaims',
  'ungroundedClaims',
]

function violationKey(v: BenchViolation): string {
  // Compares BY CATEGORY + rough locus, not by effect id (replay effect
  // ids are freshly generated every run, and are never expected to match
  // historical ones) — "is this the SAME KIND of safety problem, in
  // roughly the same place" is the right granularity for "did we fix
  // it / still have it / just introduce it", not exact effect identity.
  return `${v.invariant}:${v.detail.replace(/\b(effect|fx)[-_]?\d+\b/gi, '#')}`
}

export interface ReplayComparisonReport {
  traceId: string
  runId: string
  generatedAt: string
  sourceDescription: string
  incidentRefs: string[]
  historical: {
    violations: BenchViolation[]
    metrics: BenchQualityMetrics
    qualityScore: number
  }
  replay: BenchScenarioResult
  safetyRegressions: BenchViolation[]
  safetyImprovements: BenchViolation[]
  persistingSafetyIssues: BenchViolation[]
  safetyVerdict: 'REGRESSED' | 'IMPROVED' | 'UNCHANGED'
  behaviorDeltas: BehaviorDelta[]
  behaviorVerdict: 'IMPROVED' | 'WORSE' | 'NEUTRAL' | 'MIXED'
  expectedChanges: string[]
}

/** Evaluates `trace.historicalEffects` through the real hard-invariant
 *  gate, chronologically interleaved with `trace.events` so a
 *  `correction` event only counts against effects that happened AT OR
 *  AFTER it — the same ordering guarantee `runBenchScenario` gives a
 *  live replay run for free by processing one event at a time. */
function evaluateHistorical(trace: ReplayTrace): BenchViolation[] {
  const gate = new BenchInvariantGate()
  const violations: BenchViolation[] = []
  const events = [...trace.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const effects = [...trace.historicalEffects].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  let eventIdx = 0
  for (const effect of effects) {
    while (eventIdx < events.length && Date.parse(events[eventIdx].at) <= Date.parse(effect.at)) {
      gate.observeEvent(events[eventIdx])
      eventIdx += 1
    }
    violations.push(...gate.evaluate(effect, trace.workspaceId))
  }
  return violations
}

function directionFor(metric: keyof BenchQualityMetrics, historical: number, replay: number): BehaviorDelta['direction'] {
  if (historical === replay) return 'same'
  const replayHigher = replay > historical
  const higherIsBetter = !LOWER_IS_BETTER.has(metric)
  return replayHigher === higherIsBetter ? 'better' : 'worse'
}

function deterministicRunId(traceId: string, replayScenarioId: string, generatedAt: string): string {
  return createHash('sha256').update(`${traceId}:${replayScenarioId}:${generatedAt}`).digest('hex').slice(0, 16)
}

export function compareReplayToHistory(trace: ReplayTrace, replay: BenchScenarioResult, generatedAt: string = new Date().toISOString()): ReplayComparisonReport {
  const historicalViolations = evaluateHistorical(trace)
  const historicalKeys = new Set(historicalViolations.map(violationKey))
  const replayKeys = new Set(replay.violations.map(violationKey))

  const safetyRegressions = replay.violations.filter((v) => !historicalKeys.has(violationKey(v)))
  const safetyImprovements = historicalViolations.filter((v) => !replayKeys.has(violationKey(v)))
  const persistingSafetyIssues = replay.violations.filter((v) => historicalKeys.has(violationKey(v)))

  const safetyVerdict: ReplayComparisonReport['safetyVerdict'] =
    safetyRegressions.length > 0 ? 'REGRESSED' : safetyImprovements.length > 0 ? 'IMPROVED' : 'UNCHANGED'

  const historicalMetrics = computeQualityMetrics(trace.historicalEffects, 1)
  const historicalQualityScore = computeQualityScore(historicalMetrics)

  const behaviorDeltas: BehaviorDelta[] = COMPARED_METRICS.map((metric) => ({
    metric,
    historical: historicalMetrics[metric],
    replay: replay.metrics[metric],
    direction: directionFor(metric, historicalMetrics[metric], replay.metrics[metric]),
  })).filter((d) => d.direction !== 'same' || d.historical !== 0 || d.replay !== 0)

  const meaningful = behaviorDeltas.filter((d) => d.direction !== 'same')
  const better = meaningful.filter((d) => d.direction === 'better').length
  const worse = meaningful.filter((d) => d.direction === 'worse').length
  const behaviorVerdict: ReplayComparisonReport['behaviorVerdict'] =
    meaningful.length === 0 ? 'NEUTRAL' : better > 0 && worse > 0 ? 'MIXED' : better > worse ? 'IMPROVED' : worse > better ? 'WORSE' : 'NEUTRAL'

  return {
    traceId: trace.traceId,
    runId: deterministicRunId(trace.traceId, replay.scenarioId, generatedAt),
    generatedAt,
    sourceDescription: trace.sourceDescription,
    incidentRefs: trace.incidentRefs ?? [],
    historical: { violations: historicalViolations, metrics: historicalMetrics, qualityScore: historicalQualityScore },
    replay,
    safetyRegressions,
    safetyImprovements,
    persistingSafetyIssues,
    safetyVerdict,
    behaviorDeltas,
    behaviorVerdict,
    expectedChanges: [
      'Historical behavior is NOT treated as correct by definition — see historical.violations. ' +
        'This report compares semantic outcomes and invariant behavior, never exact reply wording.',
    ],
  }
}
