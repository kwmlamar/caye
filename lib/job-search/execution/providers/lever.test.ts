import { describe, expect, it, vi } from 'vitest'

const discoverLeverFields = vi.fn()
const prepareLeverForm = vi.fn()
vi.mock('./lever-form-session', () => ({ discoverLeverFields: (...args: unknown[]) => discoverLeverFields(...args), prepareLeverForm: (...args: unknown[]) => prepareLeverForm(...args) }))

import { leverAtsProvider } from './lever'
import type { DiscoveredField, SubmissionRequest } from '../types'

const field: DiscoveredField = { providerFieldId: 'name', label: 'Full name', semanticKey: 'full_name', inputType: 'text', required: true, allowedOptions: null, confidence: 0.9 }
function request(): SubmissionRequest {
  return {
    applicationId: 'app-1',
    candidateId: 'cand-1',
    applyUrl: 'https://jobs.lever.co/exampleco/11111111-1111-1111-1111-111111111111/apply',
    resume: { id: 'artifact-1', applicationId: 'app-1', variantId: 'variant-1', content: 'Tailored resume text.', artifactType: 'resume' },
    coverLetter: null,
    answers: [{ status: 'resolved', field, value: 'Founder Name', source: 'application_specific', reusable: false }],
    founder: { fullName: 'Founder Name', email: 'founder@example.com', phone: null },
  }
}

describe('leverAtsProvider', () => {
  it('declares no live-submission capability — Lever universally requires an hCaptcha this operator will never solve', () => {
    expect(leverAtsProvider.canSubmit).toBe(false)
    expect(leverAtsProvider.submitLive).toBeUndefined()
  })

  it('submit() always refuses, citing the hCaptcha requirement, and performs no action', async () => {
    const result = await leverAtsProvider.submit(request(), [field])
    expect(result).toMatchObject({ outcome: 'not_supported' })
    if (result.outcome === 'not_supported') expect(result.reason).toMatch(/hCaptcha/i)
  })

  it('discoverFields delegates to the DOM-based discovery module', async () => {
    discoverLeverFields.mockResolvedValue({ outcome: 'clear', fields: [field], domainValidations: [] })
    const result = await leverAtsProvider.discoverFields('https://jobs.lever.co/exampleco/11111111-1111-1111-1111-111111111111/apply')
    expect(discoverLeverFields).toHaveBeenCalledWith('https://jobs.lever.co/exampleco/11111111-1111-1111-1111-111111111111/apply')
    expect(result.outcome).toBe('clear')
  })

  it('dryRun reports ready and closes the session without ever submitting', async () => {
    const close = vi.fn(async () => undefined)
    prepareLeverForm.mockResolvedValue({ outcome: 'prepared', session: { page: {}, resumeSha256: 'abc', close } })
    const result = await leverAtsProvider.dryRun!(request(), [field])
    expect(result.outcome).toBe('ready')
    expect(close).toHaveBeenCalledOnce()
  })

  it('dryRun reports needs_human when preparation is blocked (e.g. captcha)', async () => {
    prepareLeverForm.mockResolvedValue({ outcome: 'needs_human', reason: "Lever's hosted application form requires solving an hCaptcha challenge — automation stopped without attempting it." })
    const result = await leverAtsProvider.dryRun!(request(), [field])
    expect(result.outcome).toBe('needs_human')
    expect(result.reason).toMatch(/hCaptcha/i)
  })
})
