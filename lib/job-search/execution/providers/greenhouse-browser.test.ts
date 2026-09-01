import { beforeEach, describe, expect, it, vi } from 'vitest'

const labelledControl = { count: vi.fn(async () => 1), fill: vi.fn(), selectOption: vi.fn(), setInputFiles: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
const roleOption = { count: vi.fn(async () => 1), click: vi.fn(), first() { return this } }
const page = {
  route: vi.fn(), goto: vi.fn(), url: vi.fn(() => 'https://job-boards.greenhouse.io/example/jobs/1'),
  setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(), waitForLoadState: vi.fn(),
  locator: vi.fn(), getByLabel: vi.fn(() => labelledControl), getByRole: vi.fn(() => roleOption),
}
const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined), on: vi.fn() }
const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) }
vi.mock('./serverless-chromium', () => ({ launchServerlessChromium: vi.fn(async () => browser) }))

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
    labelledControl.count.mockResolvedValue(1)
    labelledControl.getAttribute.mockResolvedValue(null)
    roleOption.count.mockResolvedValue(1)
    const body = { count: vi.fn(async () => 1), innerText: vi.fn(async () => 'Apply for this job'), first() { return this } }
    const input = { count: vi.fn(async () => 1), fill: vi.fn(), selectOption: vi.fn(), setInputFiles: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    page.locator.mockImplementation((selector: string) => {
      if (selector === 'body') return body
      if (selector === 'input[type="file"]') return input
      return input
    })
    page.getByLabel.mockReturnValue(labelledControl)
    page.getByRole.mockReturnValue(roleOption)
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

  it('falls back to the exact accessible label when Greenhouse API field name is not the hosted DOM name', async () => {
    const linkedIn: DiscoveredField = {
      providerFieldId: 'question_123456', label: 'LinkedIn Profile', semanticKey: 'linkedin', inputType: 'text', required: true, allowedOptions: null, confidence: 0.9,
    }
    const noMatch = { count: vi.fn(async () => 0), fill: vi.fn(), selectOption: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    const fileInput = { count: vi.fn(async () => 1), fill: vi.fn(), selectOption: vi.fn(), setInputFiles: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    const body = { count: vi.fn(async () => 1), innerText: vi.fn(async () => 'Apply for this job'), first() { return this } }
    page.locator.mockImplementation((selector: string) => {
      if (selector === 'body') return body
      if (selector === 'input[type="file"]') return fileInput
      return noMatch
    })
    page.getByLabel.mockReturnValue(labelledControl)

    const result = await runGreenhouseBrowserReadiness({
      ...request,
      answers: [{ status: 'resolved', field: linkedIn, value: 'https://www.linkedin.com/in/founder', source: 'profile_fact', profileFactId: 'fact-1', reusable: true }],
    }, [linkedIn])

    expect(result.outcome).toBe('ready')
    expect(page.getByLabel).toHaveBeenCalledOnce()
    expect(labelledControl.fill).toHaveBeenCalledWith('https://www.linkedin.com/in/founder')
  })

  it('fills an accessible Greenhouse custom combobox by one exact verified option label', async () => {
    const country: DiscoveredField = {
      providerFieldId: 'country', label: 'Country', semanticKey: 'country', inputType: 'select', required: true,
      allowedOptions: [{ label: 'United States', value: 'US' }, { label: 'United Kingdom', value: 'GB' }], confidence: 1,
    }
    const noMatch = { count: vi.fn(async () => 0), fill: vi.fn(), selectOption: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    const customCombobox = { count: vi.fn(async () => 1), fill: vi.fn(), selectOption: vi.fn(), getAttribute: vi.fn(async () => 'combobox'), click: vi.fn(), first() { return this } }
    const fileInput = { count: vi.fn(async () => 1), fill: vi.fn(), selectOption: vi.fn(), setInputFiles: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    const body = { count: vi.fn(async () => 1), innerText: vi.fn(async () => 'Apply for this job'), first() { return this } }
    page.locator.mockImplementation((selector: string) => {
      if (selector === 'body') return body
      if (selector === 'input[type="file"]') return fileInput
      return noMatch
    })
    page.getByLabel.mockReturnValue(customCombobox)
    page.getByRole.mockReturnValue(roleOption)

    const result = await runGreenhouseBrowserReadiness({
      ...request,
      answers: [{ status: 'resolved', field: country, value: 'US', source: 'application_specific', reusable: false }],
    }, [country])

    expect(result.outcome).toBe('ready')
    expect(customCombobox.selectOption).not.toHaveBeenCalled()
    expect(customCombobox.click).toHaveBeenCalledOnce()
    expect(page.getByRole).toHaveBeenCalledWith('option', { name: 'United States', exact: true })
    expect(roleOption.click).toHaveBeenCalledOnce()
  })

  it('fails closed when a custom combobox exposes multiple exact options', async () => {
    const country: DiscoveredField = {
      providerFieldId: 'country', label: 'Country', semanticKey: 'country', inputType: 'select', required: true,
      allowedOptions: [{ label: 'United States', value: 'US' }], confidence: 1,
    }
    const noMatch = { count: vi.fn(async () => 0), fill: vi.fn(), selectOption: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    const customCombobox = { count: vi.fn(async () => 1), fill: vi.fn(), selectOption: vi.fn(), getAttribute: vi.fn(async () => 'combobox'), click: vi.fn(), first() { return this } }
    const body = { count: vi.fn(async () => 1), innerText: vi.fn(async () => 'Apply for this job'), first() { return this } }
    const ambiguousOption = { count: vi.fn(async () => 2), click: vi.fn(), first() { return this } }
    page.locator.mockImplementation((selector: string) => selector === 'body' ? body : noMatch)
    page.getByLabel.mockReturnValue(customCombobox)
    page.getByRole.mockReturnValue(ambiguousOption)

    const result = await runGreenhouseBrowserReadiness({
      ...request,
      answers: [{ status: 'resolved', field: country, value: 'US', source: 'application_specific', reusable: false }],
    }, [country])

    expect(result.outcome).toBe('needs_human')
    expect(result.reason).toMatch(/exposed 2 exact options/i)
    expect(ambiguousOption.click).not.toHaveBeenCalled()
  })

  it('fails closed when accessible-label resolution is ambiguous', async () => {
    const linkedIn: DiscoveredField = {
      providerFieldId: 'question_123456', label: 'LinkedIn Profile', semanticKey: 'linkedin', inputType: 'text', required: true, allowedOptions: null, confidence: 0.9,
    }
    const noMatch = { count: vi.fn(async () => 0), fill: vi.fn(), selectOption: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    const body = { count: vi.fn(async () => 1), innerText: vi.fn(async () => 'Apply for this job'), first() { return this } }
    const ambiguous = { count: vi.fn(async () => 2), fill: vi.fn(), selectOption: vi.fn(), setInputFiles: vi.fn(), getAttribute: vi.fn(async () => null), click: vi.fn(), first() { return this } }
    page.locator.mockImplementation((selector: string) => selector === 'body' ? body : noMatch)
    page.getByLabel.mockReturnValue(ambiguous)

    const result = await runGreenhouseBrowserReadiness({
      ...request,
      answers: [{ status: 'resolved', field: linkedIn, value: 'https://www.linkedin.com/in/founder', source: 'profile_fact', profileFactId: 'fact-1', reusable: true }],
    }, [linkedIn])

    expect(result.outcome).toBe('needs_human')
    expect(result.reason).toMatch(/ambiguous controls/i)
    expect(ambiguous.fill).not.toHaveBeenCalled()
  })

  it('rejects a prohibited initial destination before launching a browser', async () => {
    const result = await runGreenhouseBrowserReadiness({ ...request, applyUrl: 'http://127.0.0.1:3000/apply' }, [field])
    expect(result.outcome).toBe('needs_human')
    expect(browser.newContext).not.toHaveBeenCalled()
  })
})