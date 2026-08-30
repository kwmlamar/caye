import { beforeEach, describe, expect, it, vi } from 'vitest'

const page = {
  route: vi.fn(), goto: vi.fn(), url: vi.fn(() => 'https://job-boards.greenhouse.io/example/jobs/1'),
  setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(), waitForLoadState: vi.fn(),
  locator: vi.fn(),
}
const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) }
const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) }
vi.mock('playwright', () => ({ chromium: { launch: vi.fn(async () => browser) } }))

import { runGreenhouseBrowserReadiness } from './greenhouse-browser'
import type { DiscoveredField, SubmissionRequest } from '../types'

const field: DiscoveredField = { providerFieldId: 'email', label: 'Email', semanticKey: 'email', inputType: 'text', required: true, allowedOptions: null, confidence: 1 }
const request: SubmissionRequest = {
  applicationId: 'app-1', candidateId: 'candidate-1', applyUrl: 'https://job-boards.greenhouse.io/example/jobs/1',
  resume: { id: 'artifact-1', applicationId: 'app-1', variantId: 'variant-1', content: 'Verified resume', artifactType: 'resume' },
  coverLetter: null, answers: [{ status: 'resolved', field, value: 'founder@example.com', source: 'application_specific', reusable: false }],
  founder: { fullName: 'Founder', email: 'founder@example.com', phone: null },
}

describe('Greenhouse browser executor (#216)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    page.url.mockReturnValue('https://job-boards.greenhouse.io/example/jobs/1')
    page.goto.mockResolvedValue(null)
    const body = { count: vi.fn(async () => 1), innerText: vi.fn(async () => 'Apply for this job'), first() { return this } }
    const input = { count: vi.fn(async () => 1), fill: vi.fn(), selectOption: vi.fn(), setInputFiles: vi.fn(), first() { return this } }
    page.locator.mockImplementation((selector: string) => {
      if (selector === 'body') return body
      if (selector === 'input[type="file"]') return input
      return input
    })
  })

  it('uses a fresh context, uploads the verified resume, and has no submit path', async () => {
    const result = await runGreenhouseBrowserReadiness(request, [field])
    expect(result.outcome).toBe('ready')
    expect(page.locator.mock.calls.flat().join(' ')).not.toMatch(/submit/i)
    const fileInput = page.locator.mock.results.find((call) => call.type === 'return' && call.value.setInputFiles)?.value
    expect(fileInput.setInputFiles).toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringMatching(/^caye-resume-[a-f0-9]{12}\.pdf$/), mimeType: 'application/pdf' }))
    expect(context.close).toHaveBeenCalledOnce()
    expect(browser.close).toHaveBeenCalledOnce()
  })

  it('rejects a prohibited initial destination before launching a browser', async () => {
    const result = await runGreenhouseBrowserReadiness({ ...request, applyUrl: 'http://127.0.0.1:3000/apply' }, [field])
    expect(result.outcome).toBe('needs_human')
    expect(browser.newContext).not.toHaveBeenCalled()
  })
})
