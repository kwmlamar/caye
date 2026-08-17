import { buildContinuityWillFixture } from './continuity-will'
import { buildNbcLaneyScopeFixture } from './nbc-laney-scope'
import { buildJulieSearchFixture } from './julie-search'
import { buildCorrectionNarrowingFixture } from './correction-narrowing'
import { buildSendRefinementFixture } from './send-refinement'
import { buildNoUnnecessaryActionFixture } from './no-unnecessary-action'
import { buildRealNbcLaneyFixture } from './real-nbc-laney'
import { buildRealContinuityWillFixture } from './real-continuity-will'
import { buildRealPamOttDraftChannelFixture } from './real-pam-ott-draft-channel'
import type { ReplayTurnInput } from '../types'

export {
  buildContinuityWillFixture,
  buildNbcLaneyScopeFixture,
  buildJulieSearchFixture,
  buildCorrectionNarrowingFixture,
  buildSendRefinementFixture,
  buildNoUnnecessaryActionFixture,
  // PHASE 1B — built from real (PII-scrubbed) production history, not
  // synthetic. Deliberately NOT part of buildAllFixtures(): the six
  // Phase 1 fixtures are synthetic reconstructions with no live-data
  // dependency; these are historical-replay evidence and belong to the
  // separate §3 workflow in the Phase 1B report, not the fixed six-fixture
  // regression bundle.
  buildRealNbcLaneyFixture,
  buildRealContinuityWillFixture,
  // 2026-08-17 operator-channel-continuity incident — see the fixture's own
  // doc comment.
  buildRealPamOttDraftChannelFixture,
}

/** All Phase 1 regression fixtures (Cases A–F), in the order they appear
 *  in the architectural audit / runtime-convergence plan. */
export function buildAllFixtures(): ReplayTurnInput[] {
  return [
    buildContinuityWillFixture(),
    buildNbcLaneyScopeFixture(),
    buildJulieSearchFixture(),
    buildCorrectionNarrowingFixture(),
    buildSendRefinementFixture(),
    buildNoUnnecessaryActionFixture(),
  ]
}
