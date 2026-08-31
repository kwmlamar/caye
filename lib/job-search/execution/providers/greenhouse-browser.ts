/** Greenhouse applicant-page browser adapter — readiness only. Never accepts a caller URL. */
import 'server-only'
import type { DiscoveredField, SubmissionRequest } from '../types'
import { prepareGreenhouseForm } from './greenhouse-form-session'

/**
 * Runs the non-consequential Greenhouse readiness pass.
 *
 * This module has no submit selector and no click path. It brings the form to
 * a fully-filled state through the shared session module and then closes the
 * browser — the guarantee is that there is no code here that could submit,
 * not that a boolean near the final action happened to be false.
 *
 * The consequential click lives in greenhouse-submit.ts, which is separately
 * audited and reachable only through the submission authority boundary in
 * submission-gate.ts.
 */
export async function runGreenhouseBrowserReadiness(request: SubmissionRequest, fields: DiscoveredField[]): Promise<{ outcome: 'ready' | 'needs_human'; reason: string }> {
  const prepared = await prepareGreenhouseForm(request, fields)
  if (prepared.outcome !== 'prepared') return { outcome: 'needs_human', reason: prepared.reason }
  await prepared.session.close()
  return { outcome: 'ready', reason: 'Dry run completed browser field fill and resume upload; nothing was submitted.' }
}
