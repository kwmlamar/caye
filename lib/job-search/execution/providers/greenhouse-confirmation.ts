/**
 * Greenhouse post-submit confirmation classifier.
 *
 * This is the function that decides whether a real application actually
 * reached the employer. It is deliberately pure: it takes an observation of
 * the page before and after the single submit click and returns a verdict,
 * with no browser, no I/O, and no timing dependence — so every branch is
 * directly testable and an auditor can read the whole rule in one place.
 *
 * THE CORE RULE: a generic success-looking string is never sufficient.
 * "Thank you" appears on employer marketing pages, in cookie banners, in
 * unrelated newsletter widgets, and in the page's own pre-submit copy. A
 * classifier that accepts it will report SUBMITTED for applications that were
 * never sent, which is the single worst failure this operator can have — it
 * silently drops the founder out of a hiring pipeline he believes he is in.
 *
 * So a SUBMITTED verdict requires PROVIDER-SPECIFIC, POSITIVE, POST-CLICK
 * evidence. Every signal below is computed as a DIFFERENCE between the
 * before-click and after-click observation. Anything already on the page
 * before the click contributes nothing, by construction.
 *
 * When the evidence is anything less than that, the verdict is UNCERTAIN —
 * never "failed". Once the click may have happened, "we did not see proof"
 * and "it did not happen" are different statements, and only the first one is
 * true. See executor.ts for why uncertain consumes capacity and never retries.
 */

/** A Greenhouse-specific confirmation container. Matched against the element/testid/class names Greenhouse's hosted form renders after an application is accepted. */
const GREENHOUSE_CONFIRMATION_PATTERNS = [
  /application_confirmation/i,
  /application-confirmation/i,
  /confirmation__message/i,
  /data-testid="application-confirmation"/i,
  /id="application_confirmation"/i,
] as const

/** Known Greenhouse post-application route shapes. Matched on pathname+search only. */
const GREENHOUSE_POST_SUBMIT_ROUTE_PATTERNS = [
  /\/confirmation(\/|$|\?)/i,
  /[?&]application_submitted=true/i,
  /[?&]submitted=true/i,
  /\/application_confirmation/i,
  /\/thank[_-]?you(\/|$|\?)/i,
] as const

/** Generic strings that are NEVER sufficient on their own. Tracked only so the audit record can show they were seen and deliberately not relied on. */
const GENERIC_SUCCESS_PATTERNS = [
  /thank you/i,
  /application received/i,
  /we('| ha)ve received your application/i,
  /successfully submitted/i,
] as const

export type ConfirmationObservation = {
  /** Page URL immediately before the click. */
  urlBefore: string
  /** Page URL after the click settled. */
  urlAfter: string
  /** Whether the application form was present before the click. Should always be true for a real attempt. */
  formPresentBefore: boolean
  /** Whether the application form is still present after the click. */
  formPresentAfter: boolean
  /** Raw outerHTML (or a bounded slice) of the page before the click — used only to subtract pre-existing matches. */
  htmlBefore: string
  /** Raw outerHTML (or a bounded slice) of the page after the click. */
  htmlAfter: string
  /** Body innerText before the click. */
  textBefore: string
  /** Body innerText after the click. */
  textAfter: string
  /** True when the post-click URL is still on an allowlisted Greenhouse host. */
  destinationStillAllowed: boolean
  /**
   * Whether the BEFORE-click page state was actually captured.
   *
   * Every signal below is a difference between before and after. If the
   * baseline could not be read, that subtraction silently degrades into "does
   * the after-state match?", and any confirmation markup already present in
   * the employer's page template would read as fresh evidence — a false
   * SUBMITTED, which is the worst outcome this classifier can produce. So an
   * unavailable baseline forces UNCERTAIN rather than being treated as empty.
   */
  baselineCaptured: boolean
  /** Set when the page showed a challenge/login/error state after the click. */
  postClickAnomaly?: string | null
}

export type ConfirmationSignal =
  | 'greenhouse_confirmation_dom'
  | 'post_submit_route'
  | 'application_form_removed'

export type ConfirmationVerdict = {
  outcome: 'submitted' | 'uncertain'
  /** The provider-specific signals that were actually observed, post-click only. */
  signals: ConfirmationSignal[]
  /** Generic success strings observed. Never contributes to a submitted verdict; recorded for the audit trail. */
  genericSuccessTextSeen: boolean
  /** A stable identifier for the evidence, suitable for SubmissionEvidence.confirmationId. Only set when submitted. */
  confirmationId: string | null
  reason: string
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((p) => p.test(value))
}

/** True only when the pattern set matches AFTER and did NOT match BEFORE — i.e. the evidence is new. */
function newlyMatches(patterns: readonly RegExp[], before: string, after: string): boolean {
  return matchesAny(patterns, after) && !matchesAny(patterns, before)
}

function routeOf(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return null
  }
}

/**
 * Classifies one post-click observation.
 *
 * Thresholds, and why:
 *
 *  - `greenhouse_confirmation_dom` ALONE is sufficient. It is the only signal
 *    that is both provider-specific and semantically unambiguous: Greenhouse
 *    renders that container only for an accepted application, and we require
 *    it to be absent before the click, so an employer template that happens to
 *    ship the markup cannot produce a false positive.
 *
 *  - Any OTHER single signal is NOT sufficient. A route change can be an
 *    unrelated redirect; a disappearing form can be an error re-render or a
 *    client-side crash. Either one alone is exactly the ambiguity that must
 *    become UNCERTAIN. Two independent ones together are accepted.
 *
 *  - A post-click anomaly (challenge, login wall, server error) forces
 *    UNCERTAIN regardless of signals — we cannot distinguish "submitted then
 *    the page broke" from "the submit was rejected".
 */
export function classifyGreenhouseConfirmation(observation: ConfirmationObservation): ConfirmationVerdict {
  const genericSuccessTextSeen = newlyMatches(GENERIC_SUCCESS_PATTERNS, observation.textBefore, observation.textAfter)

  const signals: ConfirmationSignal[] = []

  if (newlyMatches(GREENHOUSE_CONFIRMATION_PATTERNS, observation.htmlBefore, observation.htmlAfter)) {
    signals.push('greenhouse_confirmation_dom')
  }

  const beforeRoute = routeOf(observation.urlBefore)
  const afterRoute = routeOf(observation.urlAfter)
  if (
    afterRoute !== null &&
    afterRoute !== beforeRoute &&
    matchesAny(GREENHOUSE_POST_SUBMIT_ROUTE_PATTERNS, afterRoute) &&
    !(beforeRoute !== null && matchesAny(GREENHOUSE_POST_SUBMIT_ROUTE_PATTERNS, beforeRoute))
  ) {
    signals.push('post_submit_route')
  }

  if (observation.formPresentBefore && !observation.formPresentAfter) {
    signals.push('application_form_removed')
  }

  const base = { signals, genericSuccessTextSeen }

  if (!observation.baselineCaptured) {
    return { ...base, outcome: 'uncertain', confirmationId: null, reason: 'The page state before the submit action could not be captured, so no post-submit change could be proven. Refusing to infer a submission from the after-state alone.' }
  }

  if (!observation.destinationStillAllowed) {
    return { ...base, outcome: 'uncertain', confirmationId: null, reason: 'After the submit action the page was no longer on an allowlisted Greenhouse destination, so no confirmation could be trusted.' }
  }

  if (observation.postClickAnomaly) {
    return { ...base, outcome: 'uncertain', confirmationId: null, reason: `A post-submit anomaly (${observation.postClickAnomaly}) makes the result ambiguous; the application may or may not have been accepted.` }
  }

  const strong = signals.includes('greenhouse_confirmation_dom')
  if (strong || signals.length >= 2) {
    const confirmationId = `gh_${signals.join('+')}_${Date.parse(new Date().toISOString()) || Date.now()}`
    return {
      ...base,
      outcome: 'submitted',
      confirmationId,
      reason: strong
        ? 'Greenhouse rendered its application-confirmation container, which was not present before the submit action.'
        : `Two independent post-submit signals were observed (${signals.join(', ')}).`,
    }
  }

  if (signals.length === 1) {
    return { ...base, outcome: 'uncertain', confirmationId: null, reason: `Only one weak post-submit signal (${signals[0]}) was observed. A single route change or a disappearing form is not sufficient evidence that the application was accepted.` }
  }

  return {
    ...base,
    outcome: 'uncertain',
    confirmationId: null,
    reason: genericSuccessTextSeen
      ? 'The page showed generic success-looking text but no Greenhouse-specific confirmation evidence. Generic text is never sufficient to record a submission.'
      : 'No provider-specific post-submit confirmation evidence was observed.',
  }
}
