import type Anthropic from '@anthropic-ai/sdk'
import { runBenchScenario } from '../runner'
import type { BenchModelRound } from '../model-double'
import { traceToBenchScenario } from './replay-scenario'
import { BenchReplayAdapter } from './replay-adapter'
import { compareReplayToHistory, type ReplayComparisonReport } from './compare'
import type { ReplayTrace } from './types'

/**
 * replay/run-replay.ts — the whole v2 pipeline in one call:
 *
 * `ReplayTrace -> traceToBenchScenario -> BenchReplayAdapter ->
 * runBenchScenario (v1, unmodified) -> compareReplayToHistory -> report`
 */
export interface RunReplayOptions {
  client?: Anthropic
  model?: string
  maxTokens?: number
  generatedAt?: string
  turnScripts?: Record<string, BenchModelRound[]>
}

export async function runReplay(trace: ReplayTrace, opts: RunReplayOptions = {}): Promise<ReplayComparisonReport> {
  const scenario = traceToBenchScenario(trace)
  const adapter = new BenchReplayAdapter(trace, opts)
  const replayResult = await runBenchScenario(scenario, adapter)
  return compareReplayToHistory(trace, replayResult, opts.generatedAt)
}
