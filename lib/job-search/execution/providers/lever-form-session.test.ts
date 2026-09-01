import { beforeEach, describe, expect, it, vi } from 'vitest'

function makeLocator(overrides: Record<string, unknown> = {}) {
  const base = {
    count: vi.fn(async () => 1),
    fill: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => undefined),
    setInputFiles: vi.fn(async () => undefined),
    check: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => 'INPUT'),
    first() { return this },
  }
  return { ...base, ...overrides }
}

const body = { innerText: vi.fn(async () => 'Apply for this job') }
const applicationForm = makeLocator({ count: vi.fn(async () => 1) })
const hCaptcha = makeLocator({ count: vi.fn(async () => 0) })
const fileInput = makeLocator({ count: vi.fn(async () => 1), setInputFiles: vi.fn(async () => undefined) })
const namedControl = makeLocator({ count: vi.fn(async () => 1), evaluate: vi.fn(async () => 'INPUT') })

const page = {
  route: vi.fn(async () => undefined),
  goto: vi.fn(async () => undefined),
  url: vi.fn(() => 'https://jobs.lever.co/exampleco/11111111-1111-1111-1111-111111111111/apply'),
  setDefaultNavigationTimeout: vi.fn(),
  setDefaultTimeout: vi.fn(),
  locator: vi.fn(),
  evaluate: vi.fn(async () => []),
}
const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined), on: vi.fn() }
const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) }
vi.mock('./serverless-chromium', () => ({ launchServerlessChromium: vi.fn(async () => browser) }))

import {
  challenge,
  discoverLeverFields,
  mapRawLeverBlocksToFields,
  parseLeverApplyUrl,
  prepareLeverForm,
  type RawLeverBlock,
} from './lever-form-session'
import type { DiscoveredField, SubmissionRequest } from '../types'

const APPLY_URL = 'https://jobs.lever.co/exampleco/11111111-1111-1111-1111-111111111111/apply'

describe('parseLeverApplyUrl', () => {
  it('parses a real Lever apply URL shape', () => {
    expect(parseLeverApplyUrl(APPLY_URL)).toEqual({ site: 'exampleco', postingId: '11111111-1111-1111-1111-111111111111' })
  })
  it('rejects a non-Lever host', () => {
    expect(parseLeverApplyUrl('https://evil.example.com/exampleco/11111111-1111-1111-1111-111111111111/apply')).toBeNull()
  })
  it('rejects a Lever host without a recognizable posting id', () => {
    expect(parseLeverApplyUrl('https://jobs.lever.co/exampleco/not-a-uuid/apply')).toBeNull()
  })
  it('rejects an unparseable URL', () => {
    expect(parseLeverApplyUrl('not-a-url')).toBeNull()
  })
})

describe('challenge', () => {
  it('detects an hCaptcha widget unconditionally, even with unrelated body text', () => {
    expect(challenge('Apply for this job', true)).toBe('captcha_detected')
  })
  it('detects captcha language in body text', () => {
    expect(challenge('Please solve this CAPTCHA', false)).toBe('captcha_detected')
  })
  it('detects anti-bot challenge language', () => {
    expect(challenge('Checking your browser before accessing...', false)).toBe('anti_bot_detected')
  })
  it('returns null for an ordinary apply page', () => {
    expect(challenge('Apply for this job', false)).toBeNull()
  })
})

describe('mapRawLeverBlocksToFields', () => {
  it('maps a required text field and classifies its semantic key', () => {
    const blocks: RawLeverBlock[] = [
      { label: 'Full name', required: true, controls: [{ tag: 'INPUT', type: 'text', name: 'name', required: true, value: null }], selectOptions: [] },
    ]
    const fields = mapRawLeverBlocksToFields(blocks)
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ providerFieldId: 'name', semanticKey: 'full_name', inputType: 'text', required: true })
  })

  it('marks a field required from Lever\'s label marker even when no control carries the native required attribute (verified live: Resume/CV)', () => {
    const blocks: RawLeverBlock[] = [
      { label: 'Resume/CV', required: true, controls: [{ tag: 'INPUT', type: 'file', name: 'resume', required: false, value: null }], selectOptions: [] },
    ]
    const fields = mapRawLeverBlocksToFields(blocks)
    expect(fields[0]).toMatchObject({ providerFieldId: 'resume', semanticKey: 'resume', inputType: 'file', required: true })
  })

  it('maps a native select with its option list', () => {
    const blocks: RawLeverBlock[] = [
      {
        label: 'Are you 18 years of age or older?',
        required: true,
        controls: [{ tag: 'SELECT', type: null, name: 'cards[x][field0]', required: true, value: null }],
        selectOptions: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }],
      },
    ]
    const fields = mapRawLeverBlocksToFields(blocks)
    expect(fields[0].inputType).toBe('select')
    expect(fields[0].allowedOptions).toEqual([{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }])
    // Unmapped label — never guessed.
    expect(fields[0].semanticKey).toBeNull()
  })

  it('maps a radio group to a single-choice select field, using the value as the option label (verified live: value === visible text)', () => {
    const name = 'surveysResponses[x][responses][field0]'
    const blocks: RawLeverBlock[] = [
      {
        label: 'What is your age range?',
        required: false,
        controls: [
          { tag: 'INPUT', type: 'radio', name, required: false, value: '18-20' },
          { tag: 'INPUT', type: 'radio', name, required: false, value: '21-29' },
        ],
        selectOptions: [],
      },
    ]
    const fields = mapRawLeverBlocksToFields(blocks)
    expect(fields[0].inputType).toBe('select')
    expect(fields[0].allowedOptions).toEqual([{ label: '18-20', value: '18-20' }, { label: '21-29', value: '21-29' }])
  })

  it('maps a checkbox group to multi_select', () => {
    const name = 'surveysResponses[x][responses][field1]'
    const blocks: RawLeverBlock[] = [
      {
        label: 'Ethnicity',
        required: false,
        controls: [{ tag: 'INPUT', type: 'checkbox', name, required: false, value: 'Asian' }],
        selectOptions: [],
      },
    ]
    expect(mapRawLeverBlocksToFields(blocks)[0].inputType).toBe('multi_select')
  })

  it('skips a block whose only controls are hidden', () => {
    const blocks: RawLeverBlock[] = [
      { label: '', required: false, controls: [{ tag: 'INPUT', type: 'hidden', name: 'accountId', required: false, value: null }], selectOptions: [] },
    ]
    expect(mapRawLeverBlocksToFields(blocks)).toHaveLength(0)
  })

  it('leaves an unmatched label unmapped rather than guessing', () => {
    const blocks: RawLeverBlock[] = [
      { label: 'How did you hear about us?', required: false, controls: [{ tag: 'INPUT', type: 'text', name: 'cards[x][field0]', required: false, value: null }], selectOptions: [] },
    ]
    expect(mapRawLeverBlocksToFields(blocks)[0].semanticKey).toBeNull()
  })
})

describe('discoverLeverFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    page.url.mockReturnValue(APPLY_URL)
    page.goto.mockResolvedValue(undefined)
    body.innerText.mockResolvedValue('Apply for this job')
    hCaptcha.count.mockResolvedValue(0)
    applicationForm.count.mockResolvedValue(1)
    page.evaluate.mockResolvedValue([])
    page.locator.mockImplementation((selector: string) => {
      if (selector === 'body') return body
      if (selector === '.h-captcha') return hCaptcha
      if (selector === 'form#application-form') return applicationForm
      return makeLocator()
    })
  })

  it('malformed apply URL stops before any browser launch', async () => {
    const result = await discoverLeverFields('https://jobs.lever.co/exampleco/not-a-uuid')
    expect(result.outcome).toBe('malformed_url')
    expect(browser.newContext).not.toHaveBeenCalled()
  })

  it('an apply URL on an unrelated host is rejected before any browser launch', async () => {
    const result = await discoverLeverFields('https://evil.example.com/exampleco/11111111-1111-1111-1111-111111111111/apply')
    expect(result.outcome).toBe('malformed_url')
    expect(browser.newContext).not.toHaveBeenCalled()
  })

  it('an hCaptcha widget on the page escalates to captcha_detected, never bypassed', async () => {
    hCaptcha.count.mockResolvedValue(1)
    const result = await discoverLeverFields(APPLY_URL)
    expect(result.outcome).toBe('captcha_detected')
    expect(page.evaluate).not.toHaveBeenCalled()
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('a page with no recognizable application form fails as retryable discovery_failed, not a false clear', async () => {
    applicationForm.count.mockResolvedValue(0)
    const result = await discoverLeverFields(APPLY_URL)
    expect(result.outcome).toBe('discovery_failed')
  })

  it('parses real Lever question blocks into normalized fields', async () => {
    page.evaluate.mockResolvedValue([
      { label: 'Full name', required: true, controls: [{ tag: 'INPUT', type: 'text', name: 'name', required: true, value: null }], selectOptions: [] },
      { label: 'Current location', required: false, controls: [{ tag: 'INPUT', type: 'text', name: 'location', required: false, value: null }], selectOptions: [] },
    ] satisfies RawLeverBlock[])
    const result = await discoverLeverFields(APPLY_URL)
    expect(result.outcome).toBe('clear')
    if (result.outcome !== 'clear') return
    expect(result.fields).toHaveLength(2)
    expect(result.fields.find((f) => f.providerFieldId === 'name')?.semanticKey).toBe('full_name')
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('a prohibited initial destination stops before launching a browser', async () => {
    const result = await discoverLeverFields('http://127.0.0.1:3000/exampleco/11111111-1111-1111-1111-111111111111/apply')
    expect(result.outcome).toBe('malformed_url')
    expect(browser.newContext).not.toHaveBeenCalled()
  })
})

describe('prepareLeverForm', () => {
  const field: DiscoveredField = { providerFieldId: 'name', label: 'Full name', semanticKey: 'full_name', inputType: 'text', required: true, allowedOptions: null, confidence: 0.9 }

  function request(overrides: Partial<SubmissionRequest> = {}): SubmissionRequest {
    return {
      applicationId: 'app-1',
      candidateId: 'cand-1',
      applyUrl: APPLY_URL,
      resume: { id: 'artifact-1', applicationId: 'app-1', variantId: 'variant-1', content: 'Tailored resume text.', artifactType: 'resume' },
      coverLetter: null,
      answers: [{ status: 'resolved', field, value: 'Founder Name', source: 'application_specific', reusable: false }],
      founder: { fullName: 'Founder Name', email: 'founder@example.com', phone: null },
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    page.url.mockReturnValue(APPLY_URL)
    page.goto.mockResolvedValue(undefined)
    body.innerText.mockResolvedValue('Apply for this job')
    hCaptcha.count.mockResolvedValue(0)
    applicationForm.count.mockResolvedValue(1)
    namedControl.count.mockResolvedValue(1)
    namedControl.evaluate.mockResolvedValue('INPUT')
    fileInput.count.mockResolvedValue(1)
    page.locator.mockImplementation((selector: string) => {
      if (selector === 'body') return body
      if (selector === '.h-captcha') return hCaptcha
      if (selector === 'form#application-form') return applicationForm
      if (selector === 'input[type="file"]') return fileInput
      return namedControl
    })
  })

  it('fills the named control and uploads the resume', async () => {
    const result = await prepareLeverForm(request(), [field])
    expect(result.outcome).toBe('prepared')
    expect(namedControl.fill).toHaveBeenCalledWith('Founder Name')
    expect(fileInput.setInputFiles).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'application/pdf' }))
    if (result.outcome === 'prepared') await result.session.close()
  })

  it('a select control is filled with selectOption, not fill', async () => {
    namedControl.evaluate.mockResolvedValue('SELECT')
    const selectField: DiscoveredField = { ...field, inputType: 'select', allowedOptions: [{ label: 'Yes', value: 'Yes' }] }
    const result = await prepareLeverForm(request({ answers: [{ status: 'resolved', field: selectField, value: 'Yes', source: 'application_specific', reusable: false }] }), [selectField])
    expect(result.outcome).toBe('prepared')
    expect(namedControl.selectOption).toHaveBeenCalledWith('Yes')
    expect(namedControl.fill).not.toHaveBeenCalled()
    if (result.outcome === 'prepared') await result.session.close()
  })

  it('an hCaptcha widget stops preparation before any fill', async () => {
    hCaptcha.count.mockResolvedValue(1)
    const result = await prepareLeverForm(request(), [field])
    expect(result.outcome).toBe('needs_human')
    expect(result.reason).toMatch(/hCaptcha/i)
    expect(namedControl.fill).not.toHaveBeenCalled()
  })

  it('fails closed when the named control cannot be found', async () => {
    namedControl.count.mockResolvedValue(0)
    const result = await prepareLeverForm(request(), [field])
    expect(result.outcome).toBe('needs_human')
    expect(result.reason).toMatch(/did not expose a control named/)
  })

  it('fails closed on an ambiguous radio/checkbox value match', async () => {
    namedControl.count.mockResolvedValue(3) // shared name -> group
    const target = makeLocator({ count: vi.fn(async () => 2) })
    page.locator.mockImplementation((selector: string) => {
      if (selector === 'body') return body
      if (selector === '.h-captcha') return hCaptcha
      if (selector === 'form#application-form') return applicationForm
      if (selector === 'input[type="file"]') return fileInput
      if (selector.includes('[value="')) return target
      return namedControl
    })
    const result = await prepareLeverForm(request(), [field])
    expect(result.outcome).toBe('needs_human')
    expect(result.reason).toMatch(/refusing to guess/)
  })

  it('fails closed when there is no resume upload control', async () => {
    fileInput.count.mockResolvedValue(0)
    const result = await prepareLeverForm(request(), [field])
    expect(result.outcome).toBe('needs_human')
    expect(result.reason).toMatch(/no resume upload control/)
  })
})
