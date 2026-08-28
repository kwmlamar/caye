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
 * traces back to, whether it's currently wired up to actually run
 * (`status`), and — critically — whether it currently carries KNOWN,
 * already-tracked defects, narrowly identified (as opposed to a NEW
 * violation of the same invariant category the corpus run should still
 * fail loudly on).
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

/**
 * 'active' entries are counted as corpus coverage and MUST be evaluated
 * every run — via bundled `turnScripts` (default/offline runs) or via
 * `--live`. An 'active' entry that CANNOT be evaluated this run (no
 * `turnScripts`, and not `--live`) is a COVERAGE FAILURE — reported
 * distinctly from a safety failure, but one that still fails
 * `CorpusReport.passed`, so a normal CI run is never green while an
 * intended active regression trace goes unevaluated.
 *
 * 'pending_replay_fixture' entries are explicitly, deliberately NOT yet
 * wired for automatic evaluation (e.g. freshly captured via
 * `--save`, no turnScripts authored yet) — they do not count toward
 * coverage and do not fail the run, but they always appear in the report,
 * clearly labeled, so a human can never mistake "saved" for "protecting
 * anything." Moving an entry from pending to active is a deliberate edit
 * to the registry (author a `turnScripts` entry, or explicitly accept
 * live-only coverage), never a side effect of merely saving a fixture.
 *
 * Omitting `status` defaults to 'active' — the SAFE default. Silently
 * defaulting an unwired entry to "doesn't need to run" would recreate the
 * exact bug this field exists to prevent; a human must explicitly say
 * "not yet" (`pending_replay_fixture`), not have that be the default.
 */
export type CorpusEntryStatus = 'active' | 'pending_replay_fixture'

/**
 * A narrowly identified, expected hard-invariant violation — replaces
 * bare `HardInvariantId` matching (which suppressed EVERY violation of
 * that invariant category, forever, once one instance was allowlisted).
 * `detailContains` must match a substring of the violation's `detail`
 * text (matched the same way `compare.ts`'s own `violationKey` already
 * normalizes detail text — effect ids stripped — so it stays stable
 * across runs without depending on freshly-generated effect ids). A
 * violation of the SAME invariant with a detail that does NOT contain
 * this substring is treated as a genuinely NEW violation and fails the
 * run, even though another violation of that invariant is allowlisted.
 */
export interface ExpectedDefect {
  invariant: HardInvariantId
  /** Stable substring identifying THIS specific known defect's locus —
   *  e.g. the tool name, fact key, or other semantic detail that appears
   *  in the violation's `detail` text — not just the invariant category. */
  detailContains: string
  /** Required whenever an entry declares any ExpectedDefect — free-text
   *  (e.g. a Linear ref) explaining what the known defect is and why it's
   *  tracked here instead of fixed. Enforced by `validateCorpus`. */
  note: string
}

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
  /** See `CorpusEntryStatus`. Defaults to 'active' when omitted. */
  status?: CorpusEntryStatus
  /**
   * Narrowly identified violations this trace's REPLAY is CURRENTLY KNOWN
   * to still produce — tracked, not-yet-fixed defects, not a surprise.
   * `runCorpus` reports these separately from unexpected violations and
   * does NOT fail the corpus run on them alone; any OTHER violation
   * (including a different occurrence of the SAME invariant) is a
   * genuine, corpus-failing regression. Leave empty/omitted for the
   * normal case (this trace's replay should be clean).
   */
  knownReplayDefects?: ExpectedDefect[]
  /** Deterministic, offline-safe scripted turns for this trace's events
   *  — what `runCorpus` uses by default (no ANTHROPIC_API_KEY needed).
   *  Required for an 'active' entry to be evaluable outside `--live`;
   *  its absence on an 'active' entry is exactly the coverage gap
   *  `runCorpus`/`validateCorpus` guard against. */
  turnScripts?: Record<string, BenchModelRound[]>
}

export type CorpusTraceOutcome = 'evaluated' | 'coverage_gap' | 'pending'

export interface CorpusTraceResult {
  traceId: string
  categories: CorpusCategory[]
  status: CorpusEntryStatus
  /** 'evaluated': this run actually replayed the trace and compared it —
   *  `comparison`/violation fields below are populated.
   *  'coverage_gap': an 'active' entry that COULD NOT be evaluated this
   *  run (no turnScripts, not --live) — a distinct failure category,
   *  never silently folded into "ran cleanly."
   *  'pending': a 'pending_replay_fixture' entry, deliberately not yet
   *  wired up — visible in every report, never counted as coverage,
   *  never itself a failure. */
  outcome: CorpusTraceOutcome
  comparison?: ReplayComparisonReport
  /** All violations found in the CURRENT replay run (from
   *  `comparison.replay.violations`) minus anything matched by an
   *  `ExpectedDefect`. Non-empty here fails the trace regardless of
   *  whether the violation is a "regression" vs. a "persisting issue"
   *  relative to history — the corpus's question is "does replay,
   *  through CURRENT code, show an unexpected hard-invariant violation,"
   *  full stop. Only present when outcome === 'evaluated'. */
  unexpectedViolations: ReplayComparisonReport['replay']['violations']
  /** Replay violations that WERE anticipated via `knownReplayDefects` —
   *  still worth surfacing (nothing here means "fixed, remove the
   *  entry"), just not a build-breaking surprise. */
  knownDefectsStillPresent: ReplayComparisonReport['replay']['violations']
  /** `knownReplayDefects` entries that did NOT reproduce this run — a
   *  positive signal ("looks fixed"), surfaced so a human can go remove
   *  the stale allowlist entry. Never fails the run by itself. */
  fixedKnownDefects: ExpectedDefect[]
  /** true iff outcome !== 'coverage_gap' AND (outcome === 'pending' OR
   *  unexpectedViolations is empty). Never influenced by
   *  behaviorVerdict/qualityScore — mirrors compare.ts's own hard/quality
   *  separation one level up. */
  passed: boolean
}

export interface CorpusReport {
  schemaVersion: 1
  runId: string
  generatedAt: string
  /** Total entries in the corpus passed in, run or not. Never shrinks to
   *  hide a skipped/unevaluated entry — every entry appears in `perTrace`
   *  with an explicit `outcome`. */
  traceCount: number
  /** 'active' entries in the corpus (coverage-relevant), regardless of
   *  whether they were actually evaluated this run. */
  activeCount: number
  /** 'pending_replay_fixture' entries — visible, not coverage-relevant. */
  pendingCount: number
  /** Active entries actually replayed and compared this run. */
  evaluatedCount: number
  /** Active entries that could NOT be evaluated this run (no turnScripts,
   *  not --live) — the count that must be zero for `passed`, reported
   *  separately from `hardInvariantFailures` so "no coverage" is never
   *  confused with "no safety violation found." */
  coverageGapCount: number
  /** Entries actually executed this run — alias of evaluatedCount, kept
   *  for readability in report output. */
  ranCount: number
  /** traceIds of entries with outcome 'coverage_gap' this run. */
  coverageGapTraceIds: string[]
  /** traceIds of entries with outcome 'pending' this run. */
  pendingTraceIds: string[]
  /** Count of EVALUATED traces with at least one UNEXPECTED violation —
   *  the safety-failure count, kept separate from coverageGapCount. */
  hardInvariantFailures: number
  safetyRegressionCount: number
  safetyImprovementCount: number
  knownDefectCount: number
  /** knownReplayDefects entries that did not reproduce this run, across
   *  the whole corpus — a "these allowlist entries look stale" signal. */
  fixedKnownDefectCount: number
  behaviorVerdictCounts: Record<'IMPROVED' | 'WORSE' | 'NEUTRAL' | 'MIXED', number>
  aggregateQualityScore: { historical: number; replay: number }
  perTrace: CorpusTraceResult[]
  /** hardInvariantFailures === 0 AND coverageGapCount === 0. A normal CI
   *  run is never green while either an unexpected safety violation OR an
   *  intended-active, unevaluated trace exists. */
  passed: boolean
}
