export { BenchClock } from './clock'
export { BenchInvariantGate } from './gate'
export { runBenchScenario, runCayeBench } from './runner'
export { computeQualityMetrics, computeQualityScore } from './scoring'
export { ScriptedBenchAdapter } from './scripted-adapter'
export { ProductionBenchAdapter } from './production-adapter'
export { canonicalBenchScenarios } from './scenarios'
export type * from './types'

// Caye Bench v2 — recorded-production replay. See lib/caye-bench/replay/
// and this package's README for the pipeline this exposes:
// ReplayTrace -> BenchReplayAdapter -> runBenchScenario -> comparison report.
export { sanitizeRawTrace, redactPII } from './replay/sanitize'
export { parseReplayTrace, loadReplayTraceFile } from './replay/trace-io'
export { traceToBenchScenario } from './replay/replay-scenario'
export { BenchReplayAdapter } from './replay/replay-adapter'
export { compareReplayToHistory } from './replay/compare'
export { runReplay } from './replay/run-replay'
export { formatComparisonReportHuman } from './replay/format-report'
export { REPLAY_FIXTURES } from './replay/fixtures'
export type * from './replay/types'
export type { ReplayComparisonReport, BehaviorDelta } from './replay/compare'
