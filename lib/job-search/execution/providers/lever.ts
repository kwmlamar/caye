/**
 * Job-search operator — Lever ATS executor.
 *
 * Second real AtsExecutorProvider implementation (Greenhouse was the
 * first). Lever is the founder's second-largest ATS pipeline by candidate
 * volume — see the CAY provider-coverage audit this PR's description links
 * to — and, unlike the long tail of one-off company-hosted forms, it is a
 * single vendor with one consistent hosted-form template, which is what
 * makes deterministic field discovery possible at all here.
 *
 * `canSubmit` is false. This is not a placeholder waiting on more work: it
 * is the honest, verified state of Lever's own hosted form. Every live
 * jobs.lever.co apply page checked while building this (two unrelated
 * employers, 2026-08-31) embeds an hCaptcha widget the backend requires a
 * token from before it will accept a submission. Solving or bypassing a
 * CAPTCHA is never something this operator attempts — see
 * lever-form-session.ts's `challenge()` — so there is no lawful live-submit
 * path today, the same honest position Greenhouse's own executor held
 * before its live-submission work landed (see SubmissionResult's
 * `not_supported` case in ../types.ts). Discovery and preparation are still
 * fully real: a Lever application gets deterministically inspected and
 * filled, so a human only needs to solve the captcha and click Submit
 * rather than start from nothing.
 */
import type { AtsExecutorProvider } from './types'
import type { FieldDiscoveryResult, SubmissionResult } from '../types'
import { discoverLeverFields, prepareLeverForm } from './lever-form-session'

export const leverAtsProvider: AtsExecutorProvider = {
  providerKey: 'lever',
  canSubmit: false,

  async discoverFields(applyUrl: string): Promise<FieldDiscoveryResult> {
    return discoverLeverFields(applyUrl)
  },

  async dryRun(request, fields) {
    const prepared = await prepareLeverForm(request, fields)
    if (prepared.outcome !== 'prepared') return { outcome: 'needs_human', reason: prepared.reason }
    await prepared.session.close()
    return { outcome: 'ready', reason: 'Dry run completed browser field fill and resume upload; nothing was submitted.' }
  },

  async submit(): Promise<SubmissionResult> {
    return {
      outcome: 'not_supported',
      reason: "Lever's hosted application form requires solving an hCaptcha challenge before it will accept a submission. Caye never attempts to solve or bypass CAPTCHAs, so this application is fully prepared but must be submitted by the founder.",
    }
  },

  // No submitLive: Lever has no audited live-submission path (see module
  // doc above). The executor never reaches a submitLive call because
  // canSubmit is false — that gate is enforced in executor.ts, not here.
}
