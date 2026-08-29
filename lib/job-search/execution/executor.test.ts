import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const discoverFields = vi.fn()
const submit = vi.fn()
vi.mock('./providers/greenhouse', () => ({ greenhouseAtsProvider: { providerKey: 'greenhouse', discoverFields: (...args: unknown[]) => discoverFields(...args), submit: (...args: unknown[]) => submit(...args) } }))

const { executeApplication } = await import('./executor')

const GREENHOUSE_URL = 'https://job-boards.greenhouse.io/exampleco/jobs/12345'

function baseline() {
  return makeFakeSupabase({
    job_search_settings: [{ id: true, paused: false, daily_application_cap: 150, minimum_queue_score: 70 }],
    job_search_execution_settings: [
      { id: true, automation_enabled: true, dry_run: true, daily_submission_cap: 3, allowlisted_providers: ['greenhouse'], allowlisted_employer_domains: [], emergency_paused: false },
    ],
    job_search_applications: [{ id: 'app-1', status: 'PREPARED', candidate_id: 'cand-1', resume_variant_id: 'variant-1', execution_attempt_count: 0 }],
    job_search_candidates: [{ id: 'cand-1', apply_url: GREENHOUSE_URL, company: 'Example Co', status: 'QUEUED' }],
    job_search_profiles: [{ id: 'profile-1', status: 'verified', full_name: 'Lamar Founder', contact_email: 'lamar@example.com', contact_phone: null, created_at: '2026-01-01T00:00:00.000Z' }],
    job_search_resume_variants: [{ id: 'variant-1', status: 'verified' }],
    job_search_generated_artifacts: [{ id: 'artifact-1', application_id: 'app-1', artifact_type: 'resume', resume_variant_id: 'variant-1', content: 'Real tailored resume content.', created_at: '2026-01-01T00:00:00.000Z' }],
    job_search_application_answers: [],
    job_search_profile_facts: [],
    job_search_execution_attempts: [],
  })
}

const sponsorshipField = { providerFieldId: 'question_555', label: 'Will you require sponsorship?', semanticKey: 'sponsorship', inputType: 'select' as const, required: true, allowedOptions: ['Yes', 'No'], confidence: 0.9 }
const unknownField = { providerFieldId: 'question_999', label: 'Anything else you want us to know?', semanticKey: null, inputType: 'textarea' as const, required: true, allowedOptions: null, confidence: 0 }

beforeEach(() => {
  fake = baseline()
  discoverFields.mockReset()
  submit.mockReset()
})

function latestAttempt() {
  const rows = fake.tables.job_search_execution_attempts
  return rows[rows.length - 1]
}

describe('executeApplication — unresolved/unknown fields always escalate, never guessed (#194 scenarios 6 & 7)', () => {
  it('an unknown required field (no semantic mapping) routes to NEEDS_HUMAN', async () => {
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [unknownField], domainValidations: [] })
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('needs_human')
    expect(submit).not.toHaveBeenCalled()
    expect(fake.tables.job_search_applications[0].status).toBe('NEEDS_HUMAN')
  })

  it('an ambiguous sponsorship field with no verified canonical answer routes to NEEDS_HUMAN', async () => {
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.reason).toMatch(/sponsorship/i)
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('executeApplication — canonical answer resolution (#194 scenarios 8 & 9)', () => {
  it('a verified founder-direct canonical answer fills the field correctly', async () => {
    fake.tables.job_search_profile_facts.push({ id: 'fact-1', profile_id: 'profile-1', canonical_key: 'sponsorship', category: 'work_authorization', question: 'Will you require sponsorship?', answer: 'No, I have OPT/EAD.', source: 'founder-direct', superseded_at: null })
    fake.tables.job_search_execution_settings[0].dry_run = false
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'submitted', evidence: { confirmationId: 'gh-123', method: 'ats_api_response', receivedAt: '2026-01-01T00:00:00.000Z' }, response: { status: 200 } })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('submitted')
    const submittedRequest = submit.mock.calls[0][0]
    const filledAnswer = submittedRequest.answers.find((a: { field: { providerFieldId: string } }) => a.field.providerFieldId === 'question_555')
    expect(filledAnswer.value).toBe('No, I have OPT/EAD.')
  })

  it('an INFERRED (never verified) fact never auto-fills a high-risk field', async () => {
    fake.tables.job_search_profile_facts.push({ id: 'fact-2', profile_id: 'profile-1', canonical_key: 'sponsorship', category: 'work_authorization', question: 'Will you require sponsorship?', answer: 'Guessed answer', source: 'inferred', superseded_at: null })
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('needs_human')
    expect(submit).not.toHaveBeenCalled()
  })

  it('a superseded (no longer active) fact never auto-fills', async () => {
    fake.tables.job_search_profile_facts.push({ id: 'fact-3', profile_id: 'profile-1', canonical_key: 'sponsorship', category: 'work_authorization', question: 'x', answer: 'stale', source: 'founder-direct', superseded_at: '2026-01-01T00:00:00.000Z' })
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('needs_human')
  })
})

describe('executeApplication — dry run (#194 scenario 26)', () => {
  it('dry run never calls provider.submit and never reaches SUBMITTED', async () => {
    fake.tables.job_search_profile_facts.push({ id: 'fact-1', profile_id: 'profile-1', canonical_key: 'sponsorship', category: 'work_authorization', question: 'q', answer: 'No.', source: 'founder-direct', superseded_at: null })
    // dry_run defaults to true in baseline()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs_human')
    expect(fake.tables.job_search_applications[0].status).not.toBe('SUBMITTED')
    expect(latestAttempt().dry_run).toBe(true)
  })
})

describe('executeApplication — CAPTCHA/anti-bot/prohibited-destination discovery outcomes escalate (#194 scenario 5)', () => {
  it('CAPTCHA during discovery -> NEEDS_HUMAN, never bypassed', async () => {
    discoverFields.mockResolvedValue({ outcome: 'captcha_detected', domainValidations: [], reason: 'CAPTCHA encountered' })
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('needs_human')
    expect(submit).not.toHaveBeenCalled()
  })

  it('a prohibited-destination discovery result -> NEEDS_HUMAN', async () => {
    discoverFields.mockResolvedValue({ outcome: 'prohibited_destination', domainValidations: [{ url: 'x', hostname: 'linkedin.com', allowed: false, reason: 'blocked' }], reason: 'blocked' })
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('needs_human')
  })
})

describe('executeApplication — audit trail (#194 scenario 27)', () => {
  it('records the exact resume artifact id, provider, and confirmation evidence for a real submission', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [{ url: GREENHOUSE_URL, hostname: 'job-boards.greenhouse.io', allowed: true, reason: 'ok' }] })
    submit.mockResolvedValue({ outcome: 'submitted', evidence: { confirmationId: 'gh-999', method: 'ats_api_response', receivedAt: '2026-01-01T00:00:00.000Z' }, response: { status: 201 } })

    await executeApplication('app-1')

    const attempt = latestAttempt()
    expect(attempt.provider).toBe('greenhouse')
    expect(attempt.resume_artifact_id).toBe('artifact-1')
    expect((attempt.confirmation_evidence as { confirmationId: string }).confirmationId).toBe('gh-999')
    expect(attempt.outcome).toBe('submitted')
  })
})

describe('executeApplication — network/uncertainty classification (#194 scenarios 16, 17, 18)', () => {
  it('a retryable failed submission is returned to PREPARED, safe to retry later', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'failed', reason: 'network error before dispatch', retryable: true })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('failed')
    expect(fake.tables.job_search_applications[0].status).toBe('PREPARED')
  })

  it('SUBMISSION_UNCERTAIN is never automatically retried by a second executeApplication call', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'submission_uncertain', reason: 'connection reset mid-response' })

    const first = await executeApplication('app-1')
    expect(first.outcome).toBe('submission_uncertain')
    expect(fake.tables.job_search_applications[0].status).toBe('SUBMISSION_UNCERTAIN')

    discoverFields.mockClear()
    submit.mockClear()
    const second = await executeApplication('app-1')
    expect(second.outcome).toBe('preflight_blocked')
    expect(discoverFields).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('executeApplication — resource/claim lifecycle on unexpected failure (#194 scenario 23 analog)', () => {
  it('an unexpected exception during discovery always releases the claim — never leaves the application stuck in APPLYING', async () => {
    discoverFields.mockRejectedValue(new Error('unexpected provider crash'))
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('needs_human')
    expect(fake.tables.job_search_applications[0].status).not.toBe('APPLYING')
    expect(fake.tables.job_search_applications[0].execution_claim_token).toBeNull()
  })
})

describe('executeApplication — preflight_blocked never claims (#194 core invariant)', () => {
  it('an already-submitted application never even attempts a claim', async () => {
    fake.tables.job_search_applications[0].status = 'SUBMITTED'
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('preflight_blocked')
    expect(discoverFields).not.toHaveBeenCalled()
  })
})
