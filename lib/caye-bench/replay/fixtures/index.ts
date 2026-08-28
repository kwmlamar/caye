import { jeffDworkinDraftFailureTrace, jeffDworkinDraftFailureTurnScripts } from './jeff-dworkin-draft-failure'
import { mrsMaxCorrectionReuseTrace, mrsMaxCorrectionReuseTurnScripts } from './mrs-max-correction-reuse'
import { autumnMcneillRedundantNotificationTrace, autumnMcneillRedundantNotificationTurnScripts } from './autumn-mcneill-redundant-notification'
import type { ReplayTrace } from '../types'
import type { BenchModelRound } from '../../model-double'

export {
  jeffDworkinDraftFailureTrace,
  jeffDworkinDraftFailureTurnScripts,
  mrsMaxCorrectionReuseTrace,
  mrsMaxCorrectionReuseTurnScripts,
  autumnMcneillRedundantNotificationTrace,
  autumnMcneillRedundantNotificationTurnScripts,
}

/** Bundled deterministic scripts, keyed by traceId — what
 *  `corpus/registry.ts` uses to run every fixture offline by default. */
export const REPLAY_FIXTURE_TURN_SCRIPTS: Record<string, Record<string, BenchModelRound[]>> = {
  [jeffDworkinDraftFailureTrace.traceId]: jeffDworkinDraftFailureTurnScripts,
  [mrsMaxCorrectionReuseTrace.traceId]: mrsMaxCorrectionReuseTurnScripts,
  [autumnMcneillRedundantNotificationTrace.traceId]: autumnMcneillRedundantNotificationTurnScripts,
}

/** Every representative historical replay trace shipped with Caye Bench
 *  v2, keyed by traceId — the CLI (`npm run caye:bench:replay -- <id>`)
 *  resolves its fixture argument against this map. */
export const REPLAY_FIXTURES: Record<string, ReplayTrace> = {
  [jeffDworkinDraftFailureTrace.traceId]: jeffDworkinDraftFailureTrace,
  [mrsMaxCorrectionReuseTrace.traceId]: mrsMaxCorrectionReuseTrace,
  [autumnMcneillRedundantNotificationTrace.traceId]: autumnMcneillRedundantNotificationTrace,
}
