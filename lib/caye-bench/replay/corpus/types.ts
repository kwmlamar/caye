import type { HardInvariantId } from '../../types'
import type { BenchModelRound } from '../../model-double'
import type { ReplayTrace } from '../types'
import type { ReplayComparisonReport } from '../compare'

/**
 * corpus/types.ts — Caye Bench v2.5: the local replay corpus.
 *
 * A `CorpusEntry` is one `ReplayTrace` plus the metadata needed to run it
 * automatically and interpret its result without a human re-deriving
 * context every time: which categories it covers, which real incident it
 * traces back to, and — critically — whether it currently carries a
 * KNOWN, already-tracked defect (as opposed to a NEW regression the
 * corpus run should fail loudly on).
 */

export type CorpusCategory =
  | 'conversation'
  | 'booking'
  | 'correction'
  | 'consequential-action'
  | 'proactive-notification'
  | 'artifact'
  | 'cross-channel'
  | 'ambiguous-failure'

export interface CorpusEntry {
  /** Must equal trace.traceId — kept as its own field so a corpus can be
   *  validated (traceId uniqueness, entry/trace agreement) without first
   *  loading and sanitizing anything. */
  traceId: string
  trace: ReplayTrace
  categories: CorpusCategory[]
  /** ISO date this entry was added to the corpus (not when the incident
   *  happened — that's on the trace itself via `sanitizedAt`/events). */
  addedAt: string
  /** git sha or repo tag the trace was captured/authored against, when
   *  known — provenance for "what version of Caye did this reconstruct
   *  a failure against," distinct from `trace.provenance` (which is
   *  about the SOURCE DATA, not the codebase version). */
  sourceVersion?: string
  /**
   * Hard-invariant categories this trace's REPLAY is CURRENTLY KNOWN to
   * still violate — a tracked, not-yet-fixed defect, not a surprise.
   * `runCorpus` reports these separately from unexpected violations and
   * does NOT fail the corpus run on them alone; anything violated
   * OUTSIDE this set is a genuine, corpus-failing regression. Leave
   * empty/omitted for the normal case (this trace's replay should be
   * clean).
   */
  knownReplayDefects?: HardInvariantId[]
  /** Free-text note on the known defect (e.g. a Linear ref) — required
   *  in spirit whenever `knownReplayDefects` is non-empty, enforced by
   *  `validateCorpus`, not the type system (a plain string union would
   *  make authoring awkward for no real safety gain). */
  knownDefectNote?: string
  /** Deterministic, offline-safe scripted turns for this trace's events
   *  — what `runCorpus` uses by default (no ANTHROPIC_API_KEY needed).
   *  Omit only for a trace meant to run live-only (rare; the corpus
   *  runner skips such entries with a warning rather than failing). */
  turnScripts?: Record<string, BenchModelRound[]>
}

export interface CorpusTraceResult {
  traceId: string
  categories: CorpusCategory[]
  comparison: ReplayComparisonReport
  /** safetyRegressions minus anything covered by knownReplayDefects. */
  unexpectedViolations: ReplayComparisonReport['safetyRegressions']
  /** safetyRegressions that WERE anticipated via knownReplayDefects —
   *  still worth surfacing (nothing here means "fixed, remove the
   *  entry"), just not a build-breaking surprise. */
  knownDefectsStillPresent: ReplayComparisonReport['safetyRegressions']
  /** true iff unexpectedViolations is empty. Never influenced by
   *  behaviorVerdict/qualityScore — mirrors compare.ts's own hard/quality
   *  separation one level up. */
  passed: boolean
}

export interface CorpusReport {
  schemaVersion: 1
  runId: string
  generatedAt: string
  /** Total entries in the corpus passed in, run or not. */
  traceCount: number
  /** Entries actually executed this run — traceCount minus
   *  skippedTraceIds.length. */
  ranCount: number
  /** Entries skipped because they have no bundled turnScripts and this
   *  run wasn't `--live` — a coverage gap to close (add a script, or run
   *  with --live), never a hard-invariant failure by itself. */
  skippedTraceIds: string[]
  /** Count of traces with at least one UNEXPECTED violation — the
   *  number that must be zero for the corpus run to pass, regardless of
   *  qualityScore. */
  hardInvariantFailures: number
  safetyRegressionCount: number
  safetyImprovementCount: number
  knownDefectCount: number
  behaviorVerdictCounts: Record<'IMPROVED' | 'WORSE' | 'NEUTRAL' | 'MIXED', number>
  aggregateQualityScore: { historical: number; replay: number }
  perTrace: CorpusTraceResult[]
  passed: boolean
}
