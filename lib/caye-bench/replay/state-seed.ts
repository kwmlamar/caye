import type { WorkspaceState } from '../production-state'
import type { ReplayTrace } from './types'

/**
 * replay/state-seed.ts
 *
 * Generalizes `production-adapter.ts`'s hardcoded, scenario-id-keyed
 * `seedFixtures` into something a replay trace's OWN data drives —
 * v1's canonical catalog is fixed (10 known scenario ids), so a switch
 * statement was the right size of tool; v2's traces are arbitrary
 * historical reconstructions, so the seed data has to travel WITH the
 * trace (`ReplayTrace.seed`, `types.ts`) instead of being hand-written
 * per scenario id in adapter code.
 */
export function seedWorkspaceStateFromTrace(state: WorkspaceState, trace: ReplayTrace): void {
  for (const booking of trace.seed.bookings ?? []) {
    state.bookings.push({ ...booking })
  }
  for (const [factKey, value] of Object.entries(trace.seed.businessFacts ?? {})) {
    state.businessFacts.set(factKey, { value, correctedAtMs: Date.parse(trace.startTime) })
  }
  for (const artifact of trace.seed.artifacts ?? []) {
    state.artifacts.set(artifact.id, { caption: artifact.caption, mime: artifact.mime, storedAtMs: Date.parse(trace.startTime) })
  }
  for (const [operation, outcome] of Object.entries(trace.seed.forcedProviderOutcomes ?? {})) {
    state.forcedProviderOutcomes.set(operation, outcome)
  }
}
