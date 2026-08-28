import type { BenchScenario } from '../types'
import type { ReplayTrace } from './types'

/**
 * replay/replay-scenario.ts
 *
 * Turns a `ReplayTrace` into the exact `BenchScenario` shape
 * `runBenchScenario`/`runCayeBench` (runner.ts, unchanged since v1)
 * already know how to run — this is the whole point of reusing
 * `BenchInputEvent`/`BenchActor` directly in the trace format (types.ts)
 * rather than a parallel event shape that would need its own converter
 * logic. A replay trace has no scenario-authored `assertions` (v1's
 * mechanism for "this specific scenario must reach this specific state")
 * — the evaluator for a replay run is `replay/compare.ts`, working from
 * `historicalEffects` and the hard-invariant gate, not hand-written
 * per-trace assertions.
 */
export function traceToBenchScenario(trace: ReplayTrace): BenchScenario {
  return {
    id: `replay-${trace.traceId}`,
    name: `Replay: ${trace.sourceDescription}`,
    description: trace.sourceDescription,
    workspaceId: trace.workspaceId,
    initialTime: trace.startTime,
    tags: ['replay', ...(trace.incidentRefs ?? [])],
    events: trace.events,
    assertions: [],
  }
}
