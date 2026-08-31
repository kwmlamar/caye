import { describe, expect, it } from 'vitest'
import { classifyGreenhouseConfirmation, type ConfirmationObservation } from './greenhouse-confirmation'

const APPLY_URL = 'https://job-boards.greenhouse.io/exampleco/jobs/12345'

function observation(overrides: Partial<ConfirmationObservation> = {}): ConfirmationObservation {
  return {
    urlBefore: APPLY_URL,
    urlAfter: APPLY_URL,
    formPresentBefore: true,
    formPresentAfter: true,
    htmlBefore: '<form id="application_form"><input name="first_name"></form>',
    htmlAfter: '<form id="application_form"><input name="first_name"></form>',
    textBefore: 'Apply for this job',
    textAfter: 'Apply for this job',
    destinationStillAllowed: true,
    postClickAnomaly: null,
    baselineCaptured: true,
    ...overrides,
  }
}

describe('classifyGreenhouseConfirmation — a SUBMITTED verdict needs provider-specific positive evidence', () => {
  it('accepts the Greenhouse confirmation container when it appears only after the click', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({
        htmlAfter: '<div id="application_confirmation">Your application has been submitted.</div>',
        formPresentAfter: false,
        textAfter: 'Your application has been submitted.',
      }),
    )
    expect(verdict.outcome).toBe('submitted')
    expect(verdict.signals).toContain('greenhouse_confirmation_dom')
    expect(verdict.confirmationId).toBeTruthy()
  })

  it('accepts two independent weaker signals together (route change + form removal)', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({
        urlAfter: 'https://job-boards.greenhouse.io/exampleco/jobs/12345/confirmation',
        formPresentAfter: false,
      }),
    )
    expect(verdict.outcome).toBe('submitted')
    expect(verdict.signals).toEqual(expect.arrayContaining(['post_submit_route', 'application_form_removed']))
  })
})

describe('classifyGreenhouseConfirmation — everything short of that is UNCERTAIN, never submitted', () => {
  it('rejects a generic "thank you" with no provider-specific evidence', () => {
    const verdict = classifyGreenhouseConfirmation(observation({ textAfter: 'Thank you! Sign up for our newsletter.' }))
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.genericSuccessTextSeen).toBe(true)
    expect(verdict.signals).toEqual([])
    expect(verdict.confirmationId).toBeNull()
  })

  it('rejects generic success text even when it is emphatic and multi-phrase', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({ textAfter: 'Thank you. Application received. We have received your application and successfully submitted it.' }),
    )
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.genericSuccessTextSeen).toBe(true)
  })

  it('rejects a confirmation container that was ALREADY on the page before the click (stale DOM)', () => {
    const stale = '<div id="application_confirmation" hidden>Your application has been submitted.</div><form id="application_form"></form>'
    const verdict = classifyGreenhouseConfirmation(observation({ htmlBefore: stale, htmlAfter: stale }))
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.signals).not.toContain('greenhouse_confirmation_dom')
  })

  it('rejects success text that was already present before the click', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({ textBefore: 'Thank you for your interest in Example Co', textAfter: 'Thank you for your interest in Example Co' }),
    )
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.genericSuccessTextSeen).toBe(false)
  })

  it('treats a lone route change as insufficient', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({ urlAfter: 'https://job-boards.greenhouse.io/exampleco/jobs/12345/confirmation' }),
    )
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.signals).toEqual(['post_submit_route'])
  })

  it('treats a lone disappearing form as insufficient (it can be an error re-render)', () => {
    const verdict = classifyGreenhouseConfirmation(observation({ formPresentAfter: false }))
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.signals).toEqual(['application_form_removed'])
  })

  it('rejects an unrelated redirect off the allowlisted destination', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({
        urlAfter: 'https://marketing.exampleco.com/thank-you',
        destinationStillAllowed: false,
        formPresentAfter: false,
        htmlAfter: '<div id="application_confirmation">Thanks!</div>',
      }),
    )
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.reason).toMatch(/no longer on an allowlisted/i)
  })

  it('forces uncertain when a challenge appears after the click, even with strong signals', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({
        htmlAfter: '<div id="application_confirmation">Submitted</div>',
        formPresentAfter: false,
        postClickAnomaly: 'challenge_after_submit',
      }),
    )
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.reason).toMatch(/anomaly/i)
  })

  it('returns uncertain when absolutely nothing changed', () => {
    const verdict = classifyGreenhouseConfirmation(observation())
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.signals).toEqual([])
    expect(verdict.genericSuccessTextSeen).toBe(false)
  })

  it('does not count a route that already looked like a confirmation route before the click', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({
        urlBefore: 'https://job-boards.greenhouse.io/exampleco/jobs/12345/confirmation',
        urlAfter: 'https://job-boards.greenhouse.io/exampleco/jobs/12345/confirmation?x=1',
        formPresentAfter: false,
      }),
    )
    expect(verdict.signals).not.toContain('post_submit_route')
    expect(verdict.outcome).toBe('uncertain')
  })

  it('never emits a confirmationId on an uncertain verdict', () => {
    const cases: Partial<ConfirmationObservation>[] = [
      { textAfter: 'Thank you' },
      { formPresentAfter: false },
      { urlAfter: `${APPLY_URL}/confirmation` },
      { destinationStillAllowed: false },
      { postClickAnomaly: 'identity_requested_after_submit' },
      {},
    ]
    for (const override of cases) {
      const verdict = classifyGreenhouseConfirmation(observation(override))
      if (verdict.outcome === 'uncertain') expect(verdict.confirmationId).toBeNull()
    }
  })
})

describe('classifyGreenhouseConfirmation — a missing baseline can never produce SUBMITTED', () => {
  // Regression: capture() previously swallowed a failed page read into an
  // empty string, which defeated the before/after subtraction. Any
  // confirmation markup already in the employer's template would then read as
  // fresh evidence and produce a FALSE submitted verdict.
  it('refuses to report submitted when the before-state could not be captured', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({
        baselineCaptured: false,
        htmlBefore: '',
        textBefore: '',
        htmlAfter: '<div id="application_confirmation">Your application has been submitted.</div>',
        formPresentAfter: false,
        textAfter: 'Your application has been submitted.',
      }),
    )
    expect(verdict.outcome).toBe('uncertain')
    expect(verdict.confirmationId).toBeNull()
    expect(verdict.reason).toMatch(/before the submit action could not be captured/i)
  })

  it('refuses even when every other signal would otherwise be sufficient', () => {
    const verdict = classifyGreenhouseConfirmation(
      observation({
        baselineCaptured: false,
        urlAfter: 'https://job-boards.greenhouse.io/exampleco/jobs/12345/confirmation',
        formPresentAfter: false,
        htmlAfter: '<div id="application_confirmation">ok</div>',
      }),
    )
    expect(verdict.outcome).toBe('uncertain')
  })
})
