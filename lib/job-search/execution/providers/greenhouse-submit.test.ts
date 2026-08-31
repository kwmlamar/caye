import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DiscoveredField, SubmissionRequest } from '../types'

vi.mock('server-only', () => ({}))

/**
 * A scriptable fake Greenhouse hosted form.
 *
 * Modelled on the DOM the real production readiness pass resolved against a
 * live posting: an application form containing labelled controls, a file
 * input, and one submit button. `afterClick` rewrites the page the way a real
 * navigation would, so the confirmation classifier is exercised against a
 * genuine before/after difference rather than a hand-written verdict.
 */
type PageScript = {
  submitButtons?: { visible: boolean; enabled: boolean }[]
  /** How many elements match `form#application_form`. 0 forces the fallback path. */
  applicationFormCount?: number
  formsPresent?: number
  onClick?: () => void | Promise<void>
  afterClick?: { html?: string; text?: string; url?: string; formsPresent?: number }
  bodyText?: string
}

let script: PageScript = {}
let clickCount = 0
let pageState: { html: string; text: string; url: string; formsPresent: number }

const APPLY_URL = 'https://job-boards.greenhouse.io/exampleco/jobs/12345'

function makeLocator(count: number, extra: Record<string, unknown> = {}) {
  return {
    count: vi.fn(async () => count),
    fill: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    innerText: vi.fn(async () => pageState.text),
    first() { return this },
    nth() { return this },
    ...extra,
  }
}

const clickSpy = vi.fn(async () => {
  clickCount += 1
  if (script.onClick) await script.onClick()
  if (script.afterClick) {
    pageState = {
      html: script.afterClick.html ?? pageState.html,
      text: script.afterClick.text ?? pageState.text,
      url: script.afterClick.url ?? pageState.url,
      formsPresent: script.afterClick.formsPresent ?? pageState.formsPresent,
    }
  }
})

const page = {
  setDefaultNavigationTimeout: vi.fn(),
  setDefaultTimeout: vi.fn(),
  route: vi.fn(async () => undefined),
  goto: vi.fn(async () => undefined),
  url: () => pageState.url,
  content: vi.fn(async () => pageState.html),
  waitForLoadState: vi.fn(async () => undefined),
  getByLabel: vi.fn(() => makeLocator(0)),
  locator: vi.fn((selector: string) => {
    if (selector === 'body') return makeLocator(1)
    if (selector === 'form') return makeLocator(pageState.formsPresent)
    if (selector === 'form#application_form' || selector.startsWith('form#application_form')) return makeLocator(script.applicationFormCount ?? 1, {
      locator: vi.fn(() => {
        const buttons = script.submitButtons ?? [{ visible: true, enabled: true }]
        return {
          count: vi.fn(async () => buttons.length),
          nth: (i: number) => ({
            isVisible: vi.fn(async () => buttons[i].visible),
            isEnabled: vi.fn(async () => buttons[i].enabled),
            click: clickSpy,
          }),
        }
      }),
    })
    if (selector === 'input[type="file"]') return makeLocator(1)
    return makeLocator(0)
  }),
}

const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined), on: vi.fn() }
const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) }
vi.mock('./serverless-chromium', () => ({ launchServerlessChromium: vi.fn(async () => browser) }))

const { submitGreenhouseApplication } = await import('./greenhouse-submit')

const field: DiscoveredField = {
  providerFieldId: 'question_1', label: 'First Name', semanticKey: 'first_name', inputType: 'text', required: true, allowedOptions: null, confidence: 0.9,
}

function request(): SubmissionRequest {
  return {
    applicationId: 'app-1',
    candidateId: 'cand-1',
    applyUrl: APPLY_URL,
    resume: { id: 'artifact-1', applicationId: 'app-1', variantId: 'variant-1', content: 'Resume text.', artifactType: 'resume' },
    coverLetter: null,
    answers: [],
    founder: { fullName: 'Lamar Founder', email: 'lamar@example.com', phone: null },
  }
}

const allow = async () => ({ ok: true }) as const

beforeEach(() => {
  clickCount = 0
  clickSpy.mockClear()
  browser.newContext.mockClear()
  context.newPage.mockClear()
  script = {}
  pageState = {
    html: '<form id="application_form"><input name="first_name"></form>',
    text: 'Apply for this job',
    url: APPLY_URL,
    formsPresent: 1,
  }
})

describe('submitGreenhouseApplication — exactly one consequential click', () => {
  it('clicks exactly once on a successful submission', async () => {
    script.afterClick = { html: '<div id="application_confirmation">Submitted</div>', text: 'Your application has been submitted.', formsPresent: 0 }

    const { result, telemetry } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(1)
    expect(result.outcome).toBe('submitted')
    expect(telemetry.submitClickedAt).not.toBeNull()
    expect(telemetry.submitObservedAt).not.toBeNull()
  })

  it('never clicks when the submit control is ambiguous', async () => {
    script.submitButtons = [{ visible: true, enabled: true }, { visible: true, enabled: true }]

    const { result, telemetry } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.reason).toMatch(/refusing to guess/i)
    expect(telemetry.submitClickedAt).toBeNull()
  })

  it('never clicks when no submit control is visible and enabled', async () => {
    script.submitButtons = [{ visible: false, enabled: true }, { visible: true, enabled: false }]

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
  })

  it('never clicks when the final authority check refuses', async () => {
    const { result, telemetry } = await submitGreenhouseApplication(request(), [field], async () => ({ ok: false, reason: 'Execution was emergency-paused.' }))

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.reason).toMatch(/emergency-paused/i)
    expect(telemetry.submitClickedAt).toBeNull()
  })

  it('runs the final authority check AFTER the form is filled and BEFORE the click', async () => {
    const order: string[] = []
    script.onClick = () => { order.push('click') }
    script.afterClick = { html: '<div id="application_confirmation">Submitted</div>', formsPresent: 0 }

    await submitGreenhouseApplication(request(), [field], async () => { order.push('final_check'); return { ok: true } })

    expect(order).toEqual(['final_check', 'click'])
  })
})

describe('submitGreenhouseApplication — the click is a one-way door', () => {
  it('a click that throws becomes UNCERTAIN, never failed', async () => {
    script.onClick = () => { throw new Error('Target page, context or browser has been closed') }

    const { result, telemetry } = await submitGreenhouseApplication(request(), [field], allow)

    expect(result.outcome).toBe('submission_uncertain')
    expect(telemetry.submitClickedAt).not.toBeNull()
  })

  it('a post-click observation failure becomes UNCERTAIN', async () => {
    script.afterClick = { html: '', text: '' }
    page.waitForLoadState.mockRejectedValueOnce(new Error('Navigation timeout of 8000ms exceeded'))

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(result.outcome).toBe('submission_uncertain')
  })

  it('a browser crash after the click becomes UNCERTAIN', async () => {
    script.onClick = () => { throw new Error('browser has disconnected') }

    const { result } = await submitGreenhouseApplication(request(), [field], allow)
    expect(result.outcome).toBe('submission_uncertain')
  })

  it('an ambiguous post-click page becomes UNCERTAIN and reports no confirmation', async () => {
    script.afterClick = { text: 'Something went wrong. Please try again.' }

    const { result, telemetry } = await submitGreenhouseApplication(request(), [field], allow)

    expect(result.outcome).toBe('submission_uncertain')
    expect(telemetry.confirmationMethod).toBeNull()
    expect(clickCount).toBe(1)
  })

  it('a generic "thank you" after the click is NOT enough to report submitted', async () => {
    script.afterClick = { text: 'Thank you for visiting Example Co.' }

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(result.outcome).toBe('submission_uncertain')
  })

  it('never retries the click, even on an uncertain outcome', async () => {
    script.onClick = () => { throw new Error('connection reset') }

    await submitGreenhouseApplication(request(), [field], allow)

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })
})

describe('submitGreenhouseApplication — challenges and identity walls stop before any click', () => {
  it('a CAPTCHA on the page stops the attempt without clicking or bypassing', async () => {
    pageState.text = 'Please complete the reCAPTCHA to continue'

    const { result, telemetry } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.reason).toMatch(/challenge/i)
    expect(telemetry.submitClickedAt).toBeNull()
  })

  it('a login wall stops the attempt without clicking', async () => {
    pageState.text = 'Please sign in to continue your application'

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.reason).toMatch(/login|identity/i)
  })

  it('an anti-bot challenge stops the attempt without clicking', async () => {
    pageState.text = 'Checking your browser before you access this site'

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
  })

  it('a post-click challenge becomes UNCERTAIN rather than a confident verdict', async () => {
    script.afterClick = { text: 'Please complete the captcha', html: '<div id="application_confirmation">x</div>', formsPresent: 0 }

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(result.outcome).toBe('submission_uncertain')
  })
})

describe('submitGreenhouseApplication — evidence', () => {
  it('reports a stable answer-set hash that does not contain the answer values', async () => {
    script.afterClick = { html: '<div id="application_confirmation">Submitted</div>', formsPresent: 0 }

    const withAnswer = {
      ...request(),
      answers: [{ status: 'resolved' as const, field, value: 'Lamar', source: 'application_specific' as const, reusable: false as const }],
    }
    const { telemetry } = await submitGreenhouseApplication(withAnswer, [field], allow)

    expect(telemetry.answerSetSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(telemetry.answerSetSha256).not.toContain('Lamar')
  })

  it('records the destination and result URL', async () => {
    script.afterClick = { html: '<div id="application_confirmation">Submitted</div>', formsPresent: 0, url: `${APPLY_URL}/confirmation` }

    const { telemetry } = await submitGreenhouseApplication(request(), [field], allow)

    expect(telemetry.destinationUrl).toBe(APPLY_URL)
    expect(telemetry.resultUrl).toBe(`${APPLY_URL}/confirmation`)
  })

  it('refuses a destination that is not an allowlisted Greenhouse host, before launching a browser', async () => {
    const { result } = await submitGreenhouseApplication({ ...request(), applyUrl: 'https://www.linkedin.com/jobs/view/1' }, [field], allow)

    expect(browser.newContext).not.toHaveBeenCalled()
    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
  })
})

describe('submitGreenhouseApplication — the application form must resolve uniquely', () => {
  // Regression: the form selector previously ended in a bare `form` and took
  // `.first()`. Employer-branded Greenhouse pages carry newsletter and
  // site-search forms in the header, ahead of the application form in DOM
  // order — so that resolved the marketing form and would have clicked
  // "Subscribe" instead of "Submit Application".
  it('refuses when no form carries an application-form identifier and several forms exist', async () => {
    script.applicationFormCount = 0
    pageState.formsPresent = 3

    const { result, telemetry } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.reason).toMatch(/refusing to guess which one is the application/i)
    expect(telemetry.submitClickedAt).toBeNull()
  })

  it('refuses when the page exposes no form at all', async () => {
    script.applicationFormCount = 0
    pageState.formsPresent = 0

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.reason).toMatch(/not present/i)
  })

  it('refuses when several elements match the application-form identifier', async () => {
    script.applicationFormCount = 2

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(clickCount).toBe(0)
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.reason).toMatch(/refusing to guess/i)
  })
})

describe('submitGreenhouseApplication — a failed page read never becomes a confident verdict', () => {
  it('reports UNCERTAIN when the before-click DOM could not be read', async () => {
    // page.content() throwing on the FIRST call is the baseline capture.
    page.content.mockRejectedValueOnce(new Error('Execution context was destroyed'))
    script.afterClick = { html: '<div id="application_confirmation">Submitted</div>', formsPresent: 0 }

    const { result } = await submitGreenhouseApplication(request(), [field], allow)

    expect(result.outcome).toBe('submission_uncertain')
  })
})
