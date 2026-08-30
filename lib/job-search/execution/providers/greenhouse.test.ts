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
            // Real shape, captured from a live public Greenhouse board on
            // 2026-08-29: `value` is the option's numeric identifier, and it
            // is NOT a stable encoding of the label — the same board returns
            // value 0 for "No" on one question and 239207523002 for "No" on
            // another. The label alone is therefore never submittable.
            fields: [{ name: 'question_555', type: 'multi_value_single_select', values: [{ label: 'Yes', value: 239207524002 }, { label: 'No', value: 239207523002 }] }],
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
    // The provider's own option IDs must survive discovery — losing them is
    // what made the original submission path unable to answer correctly.
    expect(sponsorship?.allowedOptions).toEqual([
      { label: 'Yes', value: '239207524002' },
      { label: 'No', value: '239207523002' },
    ])

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

describe('greenhouseAtsProvider browser capability (#216)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const field: DiscoveredField = {
    providerFieldId: 'question_555',
    label: 'Sponsorship?',
    semanticKey: 'sponsorship',
    inputType: 'select',
    required: true,
    allowedOptions: [
      { label: 'Yes', value: '1' },
      { label: 'No', value: '0' },
    ],
    confidence: 0.9,
  }

  function request(overrides: Partial<SubmissionRequest> = {}): SubmissionRequest {
    return {
      applicationId: 'app-1',
      candidateId: 'cand-1',
      applyUrl: APPLY_URL,
      resume: { id: 'artifact-1', applicationId: 'app-1', variantId: 'variant-1', content: 'Tailored resume text.', artifactType: 'resume' },
      coverLetter: null,
      answers: [{ status: 'resolved', field, value: '0', source: 'profile_fact', profileFactId: 'fact-1', reusable: true }],
      founder: { fullName: 'Lamar Founder', email: 'lamar@example.com', phone: null },
      ...overrides,
    }
  }

  it('keeps live applicant submission disabled until the browser implementation is independently validated', () => {
    expect(greenhouseAtsProvider.canSubmit).toBe(false)
  })

  it('refuses submit without touching the browser or employer API', async () => {
    await expect(greenhouseAtsProvider.submit(request(), [field])).resolves.toMatchObject({ outcome: 'not_supported' })
  })
})
