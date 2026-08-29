import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { greenhouseAtsProvider } from './greenhouse'
import type { DiscoveredField, SubmissionRequest } from '../types'

const APPLY_URL = 'https://job-boards.greenhouse.io/exampleco/jobs/12345'
const DISCOVERY_URL = 'https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/12345?questions=true'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return new Response(JSON.stringify(body), { status, headers })
}

function textResponse(body: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/html' }) {
  return new Response(body, { status, headers })
}

function redirectResponse(location: string, status = 302) {
  return new Response(null, { status, headers: { location } })
}

describe('greenhouseAtsProvider.discoverFields (#194)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('malformed apply URL stops before any network call (#194 scenario 20)', async () => {
    const result = await greenhouseAtsProvider.discoverFields('not-a-real-url')
    expect(result.outcome).toBe('malformed_url')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an apply URL on an unrelated host is rejected as a malformed/unrecognized Greenhouse URL', async () => {
    const result = await greenhouseAtsProvider.discoverFields('https://evil.example.com/exampleco/jobs/1')
    expect(result.outcome).toBe('malformed_url')
  })

  it('parses real Greenhouse question metadata into normalized fields, classifying semantic keys deterministically', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        questions: [
          { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
          { label: 'Email', required: true, fields: [{ name: 'email', type: 'input_text' }] },
          {
            label: 'Will you now or in the future require sponsorship for employment visa status?',
            required: true,
            fields: [{ name: 'question_555', type: 'yes_no', values: [{ label: 'Yes', value: '1' }, { label: 'No', value: '0' }] }],
          },
          { label: 'Are you willing to relocate?', required: false, fields: [{ name: 'question_777', type: 'yes_no' }] },
        ],
      }),
    )

    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('clear')
    if (result.outcome !== 'clear') return
    expect(fetchSpy).toHaveBeenCalledWith(DISCOVERY_URL, expect.objectContaining({ redirect: 'manual' }))

    const sponsorship = result.fields.find((f) => f.providerFieldId === 'question_555')
    expect(sponsorship?.semanticKey).toBe('sponsorship')
    expect(sponsorship?.required).toBe(true)
    expect(sponsorship?.allowedOptions).toEqual(['Yes', 'No'])

    const relocation = result.fields.find((f) => f.providerFieldId === 'question_777')
    expect(relocation?.semanticKey).toBe('relocation')
    expect(relocation?.required).toBe(false)
  })

  it('an unmatched field label is never guessed — semanticKey is null', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ questions: [{ label: 'Favorite programming language?', required: false, fields: [{ name: 'question_999', type: 'input_text' }] }] }))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('clear')
    if (result.outcome === 'clear') expect(result.fields[0].semanticKey).toBeNull()
  })

  it('CAPTCHA/challenge signal in the response escalates to captcha_detected, never bypassed (#194 scenario 5)', async () => {
    fetchSpy.mockResolvedValue(textResponse('<html>Please solve this CAPTCHA to continue</html>', 403))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('captcha_detected')
  })

  it('an anti-bot challenge page escalates to anti_bot_detected', async () => {
    fetchSpy.mockResolvedValue(textResponse('Checking your browser before accessing... Cloudflare', 503))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('anti_bot_detected')
  })

  it('a redirect to a prohibited platform (LinkedIn) during discovery stops execution (#194 scenario 4)', async () => {
    fetchSpy.mockResolvedValueOnce(redirectResponse('https://www.linkedin.com/jobs/view/999'))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('prohibited_destination')
  })

  it('a redirect to a private/internal address stops execution (#194 scenario 19)', async () => {
    fetchSpy.mockResolvedValueOnce(redirectResponse('http://169.254.169.254/latest/meta-data/'))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('prohibited_destination')
  })

  it('a redirect to an unrelated third-party domain (not even prohibited-by-name, just not Greenhouse) stops execution', async () => {
    fetchSpy.mockResolvedValueOnce(redirectResponse('https://some-random-job-board.example.com/x'))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('prohibited_destination')
  })

  it('a redirect within Greenhouse itself (e.g. boards.greenhouse.io -> boards-api.greenhouse.io) is followed', async () => {
    fetchSpy.mockResolvedValueOnce(redirectResponse('https://boards-api.greenhouse.io/v1/boards/exampleco/jobs/12345?questions=true'))
    fetchSpy.mockResolvedValueOnce(jsonResponse({ questions: [] }))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('clear')
  })

  it('a network failure during discovery is reported as retryable, not as human-review-required', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'))
    const result = await greenhouseAtsProvider.discoverFields(APPLY_URL)
    expect(result.outcome).toBe('discovery_failed')
    if (result.outcome === 'discovery_failed') expect(result.retryable).toBe(true)
  })
})

describe('greenhouseAtsProvider.submit (#194)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const field: DiscoveredField = { providerFieldId: 'question_555', label: 'Sponsorship?', semanticKey: 'sponsorship', inputType: 'select', required: true, allowedOptions: ['Yes', 'No'], confidence: 0.9 }

  function request(overrides: Partial<SubmissionRequest> = {}): SubmissionRequest {
    return {
      applicationId: 'app-1',
      candidateId: 'cand-1',
      applyUrl: APPLY_URL,
      resume: { id: 'artifact-1', applicationId: 'app-1', variantId: 'variant-1', content: 'Tailored resume text.', artifactType: 'resume' },
      coverLetter: null,
      answers: [{ status: 'resolved', field, value: 'No', source: 'profile_fact', profileFactId: 'fact-1', reusable: true }],
      founder: { fullName: 'Lamar Founder', email: 'lamar@example.com', phone: null },
      ...overrides,
    }
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('refuses to submit when a required field has no resolved answer (safety net — never guesses)', async () => {
    const result = await greenhouseAtsProvider.submit(request({ answers: [] }), [field])
    expect(result.outcome).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a positive provider confirmation (id in body) is required for SUBMITTED (#194 scenario 14)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ id: 987654321, status: 'submitted' }, 200))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('submitted')
    if (result.outcome === 'submitted') expect(result.evidence.confirmationId).toBe('987654321')
  })

  it('a 2xx response with no confirmation identifier never claims SUBMITTED — button click alone is not evidence (#194 scenario 15)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ status: 'ok' }, 200))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('submission_uncertain')
  })

  it('a 2xx response with an unparseable body is uncertain, never a guessed success', async () => {
    fetchSpy.mockResolvedValue(textResponse('not json', 200, { 'content-type': 'application/json' }))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('submission_uncertain')
  })

  it('a network failure BEFORE the request is dispatched is a safe, retryable failure (#194 scenario 16)', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.retryable).toBe(true)
  })

  it('a failure reading the response AFTER dispatch is SUBMISSION_UNCERTAIN, never a safe failure (#194 scenario 17)', async () => {
    const brokenResponse = { ok: true, status: 200, type: 'default', headers: new Headers({ 'content-type': 'application/json' }), text: () => Promise.reject(new Error('connection reset mid-response')) } as unknown as Response
    fetchSpy.mockResolvedValue(brokenResponse)
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('submission_uncertain')
  })

  it('a clean 4xx validation error is a definite, non-retryable failure — not uncertain', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ errors: ['email is invalid'] }, 422))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.retryable).toBe(false)
  })

  it('a clean 5xx error is a retryable failure, not uncertain (a real error response IS positive evidence the request did not succeed)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'internal error' }, 500))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') expect(result.retryable).toBe(true)
  })

  it('a redirect on the submit response itself is never followed — refuses and escalates', async () => {
    fetchSpy.mockResolvedValue(redirectResponse('https://www.linkedin.com/somewhere'))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('prohibited_destination')
  })

  it('CAPTCHA on the submission response escalates, never bypassed', async () => {
    fetchSpy.mockResolvedValue(textResponse('CAPTCHA required', 403))
    const result = await greenhouseAtsProvider.submit(request(), [field])
    expect(result.outcome).toBe('captcha_detected')
  })
})
