import { jeffDworkinDraftFailureTrace } from './jeff-dworkin-draft-failure'
import { mrsMaxCorrectionReuseTrace } from './mrs-max-correction-reuse'
import { autumnMcneillRedundantNotificationTrace } from './autumn-mcneill-redundant-notification'
import type { ReplayTrace } from '../types'

export { jeffDworkinDraftFailureTrace, mrsMaxCorrectionReuseTrace, autumnMcneillRedundantNotificationTrace }

/** Every representative historical replay trace shipped with Caye Bench
 *  v2, keyed by traceId — the CLI (`npm run caye:bench:replay -- <id>`)
 *  resolves its fixture argument against this map. */
export const REPLAY_FIXTURES: Record<string, ReplayTrace> = {
  [jeffDworkinDraftFailureTrace.traceId]: jeffDworkinDraftFailureTrace,
  [mrsMaxCorrectionReuseTrace.traceId]: mrsMaxCorrectionReuseTrace,
  [autumnMcneillRedundantNotificationTrace.traceId]: autumnMcneillRedundantNotificationTrace,
}
