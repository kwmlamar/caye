import { createHash } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { runReplay } from '../run-replay'
import type { CorpusEntry, CorpusReport, CorpusTraceResult } from './types'

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
 */
export interface RunCorpusOptions {
  generatedAt?: string
  client?: Anthropic
  model?: string
  maxTokens?: number
  live?: boolean
}

export async function runCorpus(entries: CorpusEntry[], opts: RunCorpusOptions = {}): Promise<CorpusReport> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const perTrace: CorpusTraceResult[] = []
  const skippedTraceIds: string[] = []

  for (const entry of entries) {
    // A trace with no bundled script (e.g. a freshly `--save`d production
    // export — see save-runner.test.ts's own note on this) can't run
    // deterministically offline. Skip it rather than failing the whole
    // batch: "this trace needs --live" is a coverage gap to report, not
    // a hard-invariant violation on entries that DID run.
    if (!opts.live && !entry.turnScripts) {
      skippedTraceIds.push(entry.traceId)
      continue
    }
    const comparison = await runReplay(entry.trace, {
      generatedAt,
      client: opts.client,
      model: opts.model,
      maxTokens: opts.maxTokens,
      turnScripts: opts.live ? undefined : entry.turnScripts,
    })

    const known = new Set(entry.knownReplayDefects ?? [])
    const unexpectedViolations = comparison.safetyRegressions.filter((v) => !known.has(v.invariant))
    const knownDefectsStillPresent = comparison.safetyRegressions.filter((v) => known.has(v.invariant))

    perTrace.push({
      traceId: entry.traceId,
      categories: entry.categories,
      comparison,
      unexpectedViolations,
      knownDefectsStillPresent,
      passed: unexpectedViolations.length === 0,
    })
  }

  const hardInvariantFailures = perTrace.filter((t) => !t.passed).length
  const safetyRegressionCount = perTrace.reduce((sum, t) => sum + t.comparison.safetyRegressions.length, 0)
  const safetyImprovementCount = perTrace.reduce((sum, t) => sum + t.comparison.safetyImprovements.length, 0)
  const knownDefectCount = perTrace.reduce((sum, t) => sum + t.knownDefectsStillPresent.length, 0)

  const behaviorVerdictCounts: CorpusReport['behaviorVerdictCounts'] = { IMPROVED: 0, WORSE: 0, NEUTRAL: 0, MIXED: 0 }
  for (const t of perTrace) behaviorVerdictCounts[t.comparison.behaviorVerdict] += 1

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
    ranCount: perTrace.length,
    skippedTraceIds,
    hardInvariantFailures,
    safetyRegressionCount,
    safetyImprovementCount,
    knownDefectCount,
    behaviorVerdictCounts,
    aggregateQualityScore: {
      historical: round1(avg(perTrace.map((t) => t.comparison.historical.qualityScore))),
      replay: round1(avg(perTrace.map((t) => t.comparison.replay.qualityScore))),
    },
    perTrace,
    // The one rule that matters: a critical (unexpected) hard-invariant
    // violation fails the corpus run regardless of aggregate quality —
    // never blended into aggregateQualityScore, mirrors compare.ts's own
    // safetyVerdict/behaviorVerdict separation one level up.
    passed: hardInvariantFailures === 0,
  }
}
