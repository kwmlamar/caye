/**
 * Greenhouse LIVE SUBMISSION - the consequential module.
 *
 * This is the only code in the repository that can cause a real job
 * application to reach an employer. It is deliberately small, deliberately
 * separate from the readiness path, and deliberately hard to call: it is
 * reachable only from executor.ts, only after the submission authority
 * boundary in submission-gate.ts has passed, and it re-checks that boundary
 * one final time in the instant before it clicks.
 *
 * DESIGN RULES, all of which are load-bearing:
 *
 *   1. EXACTLY ONE consequential browser operation. One click, on one
 *      deterministically-resolved control. There is no retry loop, no
 *      double-click, no Enter-key fallback, no form.submit() fallback, and no
 *      "try every submit-looking control" search. If the control is ambiguous
 *      the answer is NEEDS_HUMAN, because clicking the wrong thing on a real
 *      employer's form is not recoverable.
 *
 *   2. THE CLICK IS A ONE-WAY DOOR. `submitClickedAt` is stamped BEFORE the
 *      click. From that moment on, every failure path in this module returns
 *      `submission_uncertain` - never `failed`, never `retryable`. A timeout,
 *      a crash, a navigation error, or a dead worker after the click tells us
 *      nothing about whether the employer received the application. Treating
 *      that as failure would let the queue re-apply and double-submit.
 *
 *   3. CONFIRMATION IS POSITIVE AND PROVIDER-SPECIFIC. See
 *      greenhouse-confirmation.ts. Absence of proof is uncertainty, not
 *      failure and certainly not success.
 */
import 'server-only'
import crypto from 'node:crypto'
import type { Locator, Page } from 'playwright-core'
import type { DiscoveredField, SubmissionRequest, SubmissionResult } from '../types'
import type { LiveSubmissionTelemetry } from './types'
import { allowedGreenhouseNavigation, challenge, prepareGreenhouseForm, requiresIdentity } from './greenhouse-form-session'
import { classifyGreenhouseConfirmation, type ConfirmationObservation } from './greenhouse-confirmation'

const POST_CLICK_SETTLE_MS = 8_000
const HTML_CAPTURE_LIMIT = 200_000

/** The last-moment authority re-check. Supplied by the executor; runs while the form is filled and the browser is open, immediately before the click. */
export type FinalAuthorityCheck = () => Promise<{ ok: true } | { ok: false; reason: string }>

export type { LiveSubmissionTelemetry } from './types'

export type LiveSubmissionOutcome = { result: SubmissionResult; telemetry: LiveSubmissionTelemetry }

/** Stable hash over exactly what was filled, so an auditor can prove the answer set without storing the answers. */
export function hashAnswerSet(request: SubmissionRequest): string {
  // JSON-encoded tuples, sorted, so the hash is stable across answer ordering
  // and cannot be forged by a value that happens to contain a separator.
  const canonical = JSON.stringify(
    request.answers
      .filter((a) => a.status === 'resolved')
      .map((a) => [a.field.providerFieldId, a.field.label, a.status === 'resolved' ? a.value : ''])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
  )
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/**
 * Resolves the ONE submit control for the application form.
 *
 * Deterministic and conservative: it looks only for a real submit control
 * inside the application form, requires it to be visible and enabled, and
 * requires the match to be unique. Zero matches and two-or-more matches are
 * both refusals - "pick the first one" is exactly the behavior that clicks a
 * newsletter signup button on an employer's marketing footer.
 */
async function resolveApplicationForm(page: Page): Promise<{ form: Locator } | { reason: string }> {
  // Tried in order of decreasing specificity, each requiring a UNIQUE match.
  //
  // The bare `form` fallback is last and is accepted ONLY when the page has
  // exactly one form. Employer-branded Greenhouse pages routinely carry a
  // newsletter or site-search form in the header, and those appear BEFORE the
  // application form in DOM order — so a permissive selector plus `.first()`
  // resolves the marketing form and would click "Subscribe" instead of
  // "Submit Application". Requiring uniqueness makes that a refusal.
  const strategies = ['form#application_form', 'form#application-form', 'form[action*="application"]', 'form']
  for (const selector of strategies) {
    const locator = page.locator(selector)
    const count = await locator.count()
    if (count === 1) return { form: locator }
    if (count > 1 && selector !== 'form') {
      return { reason: `Greenhouse page exposed ${count} forms matching "${selector}"; refusing to guess which one is the application.` }
    }
  }
  const anyForms = await page.locator('form').count()
  if (anyForms === 0) return { reason: 'Greenhouse application form was not present when resolving the submit control.' }
  return { reason: `Greenhouse page exposed ${anyForms} forms and none carried an application-form identifier; refusing to guess which one is the application.` }
}

async function resolveSubmitControl(page: Page): Promise<{ control: Locator } | { reason: string }> {
  const resolved = await resolveApplicationForm(page)
  if ('reason' in resolved) return { reason: resolved.reason }
  const form = resolved.form

  const candidates = form.locator('button[type="submit"], input[type="submit"]')
  const total = await candidates.count()
  if (total === 0) return { reason: 'Greenhouse application form exposed no submit control.' }

  const usable: Locator[] = []
  for (let i = 0; i < total; i++) {
    const candidate = candidates.nth(i)
    if ((await candidate.isVisible().catch(() => false)) && (await candidate.isEnabled().catch(() => false))) usable.push(candidate)
  }

  if (usable.length === 0) return { reason: 'Greenhouse application form had a submit control, but none were visible and enabled.' }
  if (usable.length > 1) return { reason: `Greenhouse application form exposed ${usable.length} visible enabled submit controls; refusing to guess which one submits the application.` }
  return { control: usable[0] }
}

type PageCapture = { html: string; text: string; url: string; formPresent: boolean; captured: boolean }

/**
 * Snapshots the page. `captured` reports whether the DOM was actually read —
 * a failed read must never be indistinguishable from a genuinely empty page,
 * because the confirmation classifier reasons about the DIFFERENCE between
 * two captures and a silently-empty baseline defeats that subtraction.
 */
async function capture(page: Page): Promise<PageCapture> {
  let captured = true
  const html = await page.content().then((h) => h.slice(0, HTML_CAPTURE_LIMIT)).catch(() => { captured = false; return '' })
  const text = await page.locator('body').innerText().catch(() => { captured = false; return '' })
  const formPresent = await page.locator('form').count().then((c) => c > 0).catch(() => false)
  return { html, text, url: page.url(), formPresent, captured }
}

/**
 * Performs the single live Greenhouse submission.
 *
 * Every return before `submitClickedAt` is set is a safe non-submission.
 * Every return after it is set is `submission_uncertain` or `submitted` - the
 * `failed` outcome is structurally unreachable past the click.
 */
export async function submitGreenhouseApplication(
  request: SubmissionRequest,
  fields: DiscoveredField[],
  finalCheck: FinalAuthorityCheck,
): Promise<LiveSubmissionOutcome> {
  const answerSetSha256 = hashAnswerSet(request)
  const telemetry: LiveSubmissionTelemetry = {
    destinationUrl: request.applyUrl,
    resultUrl: null,
    submitClickedAt: null,
    submitObservedAt: null,
    resumeSha256: null,
    answerSetSha256,
    confirmationMethod: null,
    confirmationSignals: [],
  }

  const prepared = await prepareGreenhouseForm(request, fields)
  if (prepared.outcome !== 'prepared') {
    return { result: { outcome: 'failed', reason: prepared.reason, retryable: false }, telemetry }
  }

  const { page, resumeSha256, close } = prepared.session
  telemetry.resumeSha256 = resumeSha256

  try {
    const control = await resolveSubmitControl(page)
    if ('reason' in control) {
      return { result: { outcome: 'failed', reason: control.reason, retryable: false }, telemetry }
    }

    const before = await capture(page)
    telemetry.resultUrl = before.url

    // Nothing consequential has happened yet. This is the last exit.
    const authorized = await finalCheck()
    if (!authorized.ok) {
      return { result: { outcome: 'failed', reason: authorized.reason, retryable: false }, telemetry }
    }

    // ---------------------------------------------------------------------
    // ONE-WAY DOOR. Past this line every failure is UNCERTAIN, never failed.
    // ---------------------------------------------------------------------
    telemetry.submitClickedAt = new Date().toISOString()

    try {
      await control.control.click({ noWaitAfter: true, timeout: POST_CLICK_SETTLE_MS })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      telemetry.submitObservedAt = new Date().toISOString()
      return {
        result: { outcome: 'submission_uncertain', reason: `The submit click was dispatched but did not complete cleanly (${message}). The application may or may not have reached the employer; this was not retried.` },
        telemetry,
      }
    }

    let after: Awaited<ReturnType<typeof capture>>
    try {
      await page.waitForLoadState('networkidle', { timeout: POST_CLICK_SETTLE_MS }).catch(() => undefined)
      after = await capture(page)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      telemetry.submitObservedAt = new Date().toISOString()
      return {
        result: { outcome: 'submission_uncertain', reason: `The submit click completed but the resulting page could not be observed (${message}). The application may have been accepted; this was not retried.` },
        telemetry,
      }
    }

    telemetry.submitObservedAt = new Date().toISOString()
    telemetry.resultUrl = after.url

    const anomaly = challenge(after.text) ? 'challenge_after_submit' : requiresIdentity(after.text) ? 'identity_requested_after_submit' : null

    const observation: ConfirmationObservation = {
      urlBefore: before.url,
      urlAfter: after.url,
      formPresentBefore: before.formPresent,
      formPresentAfter: after.formPresent,
      htmlBefore: before.html,
      htmlAfter: after.html,
      textBefore: before.text,
      textAfter: after.text,
      destinationStillAllowed: allowedGreenhouseNavigation(after.url),
      postClickAnomaly: anomaly,
      // Both captures must be real. A missing baseline cannot prove a change,
      // and a missing after-state cannot prove a confirmation.
      baselineCaptured: before.captured && after.captured,
    }

    const verdict = classifyGreenhouseConfirmation(observation)
    telemetry.confirmationSignals = verdict.signals
    telemetry.confirmationMethod = verdict.outcome === 'submitted' ? 'browser_confirmation' : null

    if (verdict.outcome === 'submitted' && verdict.confirmationId) {
      return {
        result: {
          outcome: 'submitted',
          evidence: {
            confirmationId: verdict.confirmationId,
            method: 'browser_confirmation',
            receivedAt: telemetry.submitObservedAt,
            raw: { signals: verdict.signals, resultUrl: after.url, reason: verdict.reason },
          },
          response: { signals: verdict.signals, resultUrl: after.url },
        },
        telemetry,
      }
    }

    return {
      result: { outcome: 'submission_uncertain', reason: verdict.reason, response: { signals: verdict.signals, resultUrl: after.url, genericSuccessTextSeen: verdict.genericSuccessTextSeen } },
      telemetry,
    }
  } catch (error) {
    // An exception from anywhere in the try block. If the click already
    // happened this MUST be uncertain; if it has not, it is a safe failure.
    const message = error instanceof Error ? error.message : String(error)
    if (telemetry.submitClickedAt) {
      telemetry.submitObservedAt = telemetry.submitObservedAt ?? new Date().toISOString()
      return { result: { outcome: 'submission_uncertain', reason: `Execution failed after the submit click was dispatched (${message}). The application may have reached the employer; this was not retried.` }, telemetry }
    }
    return { result: { outcome: 'failed', reason: `Live submission failed before any submit action (${message}).`, retryable: false }, telemetry }
  } finally {
    await close()
  }
}
