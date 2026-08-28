import { createHash } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { runReplay } from '../run-replay'
import type { BenchViolation } from '../../types'
import type { CorpusEntry, CorpusReport, CorpusTraceResult, ExpectedDefect } from './types'

/**
 * corpus/run-corpus.ts — deterministic batch execution over a
 * `CorpusEntry[]`, reusing `runReplay` (v2, unmodified) per trace.
 *
 * Default mode uses each entry's bundled `turnScripts` — no
 * `ANTHROPIC_API_KEY` needed, same value proposition as
 * `cli-runner.test.ts`'s offline suite, just generalized to N traces
 * instead of 3 hand-written `it()` blocks. `opts.live: true` switches
 * every trace to genuine model reasoning (requires `opts.client`) — see
 * `corpus-runner.test.ts` for how that's gated the same way v2's CLI
 * gates it (env var only the CLI script sets, real API key required,
 * Supabase still always mocked regardless).
 *
 * Coverage vs. safety, kept strictly separate (see corpus/types.ts's own
 * header comment for the full rationale): an 'active' entry that cannot
 * be evaluated this run is a COVERAGE FAILURE (`coverageGapCount`), never
 * silently treated as "ran clean." A safety violation not covered by a
 * narrowly-matched `ExpectedDefect` is a HARD-INVARIANT FAILURE
 * (`hardInvariantFailures`). `passed` requires both to be zero.
 */
export interface RunCorpusOptions {
  generatedAt?: string
  client?: Anthropic
  model?: string
  maxTokens?: number
  live?: boolean
}

function matchesExpectedDefect(violation: BenchViolation, expected: ExpectedDefect): boolean {
  return violation.invariant === expected.invariant && violation.detail.includes(expected.detailContains)
}

export async function runCorpus(entries: CorpusEntry[], opts: RunCorpusOptions = {}): Promise<CorpusReport> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const perTrace: CorpusTraceResult[] = []

  for (const entry of entries) {
    const status = entry.status ?? 'active'
    const categories = entry.categories

    if (status === 'pending_replay_fixture') {
      // Deliberately, explicitly not yet wired for automatic evaluation.
      // Reported, never hidden, never counted as coverage, never a
      // failure — see CorpusEntryStatus's header comment.
      perTrace.push({
        traceId: entry.traceId,
        categories,
        status,
        outcome: 'pending',
        unexpectedViolations: [],
        knownDefectsStillPresent: [],
        fixedKnownDefects: [],
        passed: true,
      })
      continue
    }

    // status === 'active': coverage-relevant. Must actually run — offline
    // via bundled turnScripts, or via --live. Anything else is a
    // COVERAGE FAILURE, not a silent skip.
    if (!opts.live && !entry.turnScripts) {
      perTrace.push({
        traceId: entry.traceId,
        categories,
        status,
        outcome: 'coverage_gap',
        unexpectedViolations: [],
        knownDefectsStillPresent: [],
        fixedKnownDefects: [],
        passed: false,
      })
      continue
    }

    const comparison = await runReplay(entry.trace, {
      generatedAt,
      client: opts.client,
      model: opts.model,
      maxTokens: opts.maxTokens,
      turnScripts: opts.live ? undefined : entry.turnScripts,
    })

    // The corpus's own question — "does replay, through CURRENT code,
    // show an unexpected hard-invariant violation" — is answered against
    // ALL violations the replay run actually produced, not just the
    // subset compare.ts happens to classify as a "regression" relative to
    // history (a known defect the ORIGINAL incident already exhibited
    // shows up in persistingSafetyIssues, not safetyRegressions, and
    // still needs to be covered by knownReplayDefects to avoid failing).
    const replayViolations = comparison.replay.violations
    const expected = entry.knownReplayDefects ?? []
    const unexpectedViolations = replayViolations.filter((v) => !expected.some((d) => matchesExpectedDefect(v, d)))
    const knownDefectsStillPresent = replayViolations.filter((v) => expected.some((d) => matchesExpectedDefect(v, d)))
    const fixedKnownDefects = expected.filter((d) => !replayViolations.some((v) => matchesExpectedDefect(v, d)))

    perTrace.push({
      traceId: entry.traceId,
      categories,
      status,
      outcome: 'evaluated',
      comparison,
      unexpectedViolations,
      knownDefectsStillPresent,
      fixedKnownDefects,
      passed: unexpectedViolations.length === 0,
    })
  }

  const evaluated = perTrace.filter((t) => t.outcome === 'evaluated')
  const activeCount = perTrace.filter((t) => t.status === 'active').length
  const pendingCount = perTrace.filter((t) => t.status === 'pending_replay_fixture').length
  const coverageGaps = perTrace.filter((t) => t.outcome === 'coverage_gap')
  const hardInvariantFailures = evaluated.filter((t) => !t.passed).length

  const safetyRegressionCount = evaluated.reduce((sum, t) => sum + (t.comparison?.safetyRegressions.length ?? 0), 0)
  const safetyImprovementCount = evaluated.reduce((sum, t) => sum + (t.comparison?.safetyImprovements.length ?? 0), 0)
  const knownDefectCount = evaluated.reduce((sum, t) => sum + t.knownDefectsStillPresent.length, 0)
  const fixedKnownDefectCount = evaluated.reduce((sum, t) => sum + t.fixedKnownDefects.length, 0)

  const behaviorVerdictCounts: CorpusReport['behaviorVerdictCounts'] = { IMPROVED: 0, WORSE: 0, NEUTRAL: 0, MIXED: 0 }
  for (const t of evaluated) if (t.comparison) behaviorVerdictCounts[t.comparison.behaviorVerdict] += 1

  const avg = (values: number[]): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)
  const round1 = (n: number): number => Math.round(n * 10) / 10

  const runId = createHash('sha256')
    .update(`${entries.map((e) => e.traceId).join(',')}:${generatedAt}`)
    .digest('hex')
    .slice(0, 16)

  return {
    schemaVersion: 1,
    runId,
    generatedAt,
    traceCount: entries.length,
    activeCount,
    pendingCount,
    evaluatedCount: evaluated.length,
    coverageGapCount: coverageGaps.length,
    ranCount: evaluated.length,
    coverageGapTraceIds: coverageGaps.map((t) => t.traceId),
    pendingTraceIds: perTrace.filter((t) => t.outcome === 'pending').map((t) => t.traceId),
    hardInvariantFailures,
    safetyRegressionCount,
    safetyImprovementCount,
    knownDefectCount,
    fixedKnownDefectCount,
    behaviorVerdictCounts,
    aggregateQualityScore: {
      historical: round1(avg(evaluated.map((t) => t.comparison!.historical.qualityScore))),
      replay: round1(avg(evaluated.map((t) => t.comparison!.replay.qualityScore))),
    },
    perTrace,
    // The rule that matters: an unexpected hard-invariant violation OR an
    // active trace that went unevaluated fails the corpus run, regardless
    // of aggregate quality — never blended into aggregateQualityScore,
    // mirrors compare.ts's own safetyVerdict/behaviorVerdict separation
    // one level up.
    passed: hardInvariantFailures === 0 && coverageGaps.length === 0,
  }
}
