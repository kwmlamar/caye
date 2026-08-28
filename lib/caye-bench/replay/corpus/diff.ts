import type { CorpusReport } from './types'

/**
 * corpus/diff.ts — baseline vs. candidate corpus reports.
 *
 * Deliberately NOT cross-git-ref orchestration (checking out two refs,
 * running builds, spawning processes) — that's a real, separate feature.
 * What this provides is the part that "falls out cleanly" once two
 * `CorpusReport`s exist: a pure function comparing them, answering "did
 * this change make Caye safer or operationally better across historical
 * reality?" Intended usage until the orchestration exists:
 *
 *   git checkout main            && npm run caye:bench:corpus  # writes __output__/corpus-report.json
 *   cp lib/caye-bench/replay/corpus/__output__/corpus-report.json /tmp/baseline.json
 *   git checkout candidate-branch && npm run caye:bench:corpus
 *   node -e "console.log(JSON.stringify(require('./lib/caye-bench/replay/corpus/diff').diffCorpusReports(require('/tmp/baseline.json'), require('./lib/caye-bench/replay/corpus/__output__/corpus-report.json')), null, 2))"
 */

export interface CorpusTraceDelta {
  traceId: string
  /** Present in one report but not the other — a trace added/removed
   *  between the two runs, not a behavior change on a shared trace. */
  presence: 'both' | 'baseline-only' | 'candidate-only'
  newUnexpectedViolations: string[]
  fixedUnexpectedViolations: string[]
  behaviorVerdictChanged: boolean
  baselineBehaviorVerdict?: string
  candidateBehaviorVerdict?: string
}

export interface CorpusDiffReport {
  generatedAt: string
  baselineRunId: string
  candidateRunId: string
  /** The one question that matters, answered without averaging: any
   *  trace with a newUnexpectedViolations entry means REGRESSED, full
   *  stop, regardless of how many OTHER traces got better. */
  safetyVerdict: 'REGRESSED' | 'IMPROVED' | 'UNCHANGED'
  qualityScoreDelta: number
  traceDeltas: CorpusTraceDelta[]
  tracesAdded: string[]
  tracesRemoved: string[]
}

export function diffCorpusReports(baseline: CorpusReport, candidate: CorpusReport, generatedAt: string = new Date().toISOString()): CorpusDiffReport {
  const baselineById = new Map(baseline.perTrace.map((t) => [t.traceId, t]))
  const candidateById = new Map(candidate.perTrace.map((t) => [t.traceId, t]))
  const allIds = new Set([...baselineById.keys(), ...candidateById.keys()])

  const traceDeltas: CorpusTraceDelta[] = []
  for (const traceId of allIds) {
    const base = baselineById.get(traceId)
    const cand = candidateById.get(traceId)

    if (!base || !cand) {
      traceDeltas.push({
        traceId,
        presence: !base ? 'candidate-only' : 'baseline-only',
        newUnexpectedViolations: [],
        fixedUnexpectedViolations: [],
        behaviorVerdictChanged: false,
      })
      continue
    }

    const baseViolationKeys = new Set(base.unexpectedViolations.map((v) => `${v.invariant}:${v.detail}`))
    const candViolationKeys = new Set(cand.unexpectedViolations.map((v) => `${v.invariant}:${v.detail}`))

    traceDeltas.push({
      traceId,
      presence: 'both',
      newUnexpectedViolations: [...candViolationKeys].filter((k) => !baseViolationKeys.has(k)),
      fixedUnexpectedViolations: [...baseViolationKeys].filter((k) => !candViolationKeys.has(k)),
      // `comparison` is only present for an evaluated trace — a
      // coverage_gap/pending entry on either side has no behavior verdict
      // to compare, not a "same" verdict.
      behaviorVerdictChanged: base.comparison?.behaviorVerdict !== cand.comparison?.behaviorVerdict,
      baselineBehaviorVerdict: base.comparison?.behaviorVerdict,
      candidateBehaviorVerdict: cand.comparison?.behaviorVerdict,
    })
  }

  const anyNewViolation = traceDeltas.some((d) => d.newUnexpectedViolations.length > 0)
  const anyFixedViolation = traceDeltas.some((d) => d.fixedUnexpectedViolations.length > 0)
  const safetyVerdict: CorpusDiffReport['safetyVerdict'] = anyNewViolation ? 'REGRESSED' : anyFixedViolation ? 'IMPROVED' : 'UNCHANGED'

  return {
    generatedAt,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    safetyVerdict,
    qualityScoreDelta: Math.round((candidate.aggregateQualityScore.replay - baseline.aggregateQualityScore.replay) * 10) / 10,
    traceDeltas,
    tracesAdded: traceDeltas.filter((d) => d.presence === 'candidate-only').map((d) => d.traceId),
    tracesRemoved: traceDeltas.filter((d) => d.presence === 'baseline-only').map((d) => d.traceId),
  }
}
