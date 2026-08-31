import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const discoverFields = vi.fn()
const submit = vi.fn()
/**
 * The real Greenhouse provider exposes `dryRun` as an operation SEPARATE from
 * `submit` — it may navigate, fill and upload, but the module behind it has no
 * submit selector and no click path. Mirroring that separation here is what
 * makes "a dry-run never submits" an assertion about structure rather than
 * about a boolean checked near the final action.
 */
type ProviderDryRunResult = { outcome: 'ready' | 'needs_human'; reason: string }
function liveTelemetry(submitClickedAt: string | null) {
  return {
    destinationUrl: 'https://job-boards.greenhouse.io/exampleco/jobs/12345',
    resultUrl: 'https://job-boards.greenhouse.io/exampleco/jobs/12345',
    submitClickedAt,
    submitObservedAt: submitClickedAt ? new Date().toISOString() : null,
    resumeSha256: 'a'.repeat(64),
    answerSetSha256: 'b'.repeat(64),
    confirmationMethod: submitClickedAt ? 'browser_confirmation' : null,
    confirmationSignals: submitClickedAt ? ['greenhouse_confirmation_dom'] : [],
  }
}

const providerDryRun = vi.fn<() => Promise<ProviderDryRunResult>>(async () => ({ outcome: 'ready', reason: 'ready' }))
/**
 * `canSubmit` mirrors the real provider's capability flag. It is FALSE by
 * default here because that is what the real Greenhouse provider declares —
 * its submission endpoint needs the employer's own API key. Tests that need
 * to exercise the submission-path safety logic opt in explicitly via
 * `allowSubmission()`, which makes it impossible to write a test that
 * accidentally assumes submission is available.
 */
let canSubmit = false
const allowSubmission = () => {
  canSubmit = true
}
vi.mock('./providers/greenhouse', () => ({
  greenhouseAtsProvider: {
    providerKey: 'greenhouse',
    get canSubmit() {
      return canSubmit
    },
    discoverFields: (...args: unknown[]) => discoverFields(...args),
    dryRun: (...args: unknown[]) => providerDryRun(...(args as [])),
    submit: (...args: unknown[]) => submit(...args),
    /**
     * Models the real provider's live contract: it MUST run the executor's
     * final authority check before doing anything consequential, and it
     * reports telemetry describing whether a click was dispatched.
     *
     * It delegates the outcome to the same `submit` mock the existing tests
     * already drive, so those tests keep asserting on `submit` while now
     * flowing through the real live code path. `submitClickedAt` is derived
     * from the outcome: 'submitted' and 'submission_uncertain' both imply the
     * click happened, which is exactly the property the reservation-release
     * and no-retry logic keys off.
     */
    async submitLive(request: unknown, fields: unknown, finalCheck: () => Promise<{ ok: true } | { ok: false; reason: string }>) {
      const authorized = await finalCheck()
      if (!authorized.ok) {
        return { result: { outcome: 'failed', reason: authorized.reason, retryable: false }, telemetry: liveTelemetry(null) }
      }
      const result = await submit(request, fields)
      const clicked = result.outcome === 'submitted' || result.outcome === 'submission_uncertain'
      return { result, telemetry: liveTelemetry(clicked ? new Date().toISOString() : null) }
    },
  },
}))

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

const sponsorshipField = { providerFieldId: 'question_555', label: 'Will you require sponsorship?', semanticKey: 'sponsorship', inputType: 'text' as const, required: true, allowedOptions: null, confidence: 0.9 }
const unknownField = { providerFieldId: 'question_999', label: 'Anything else you want us to know?', semanticKey: null, inputType: 'textarea' as const, required: true, allowedOptions: null, confidence: 0 }

/** A canonical fact that is recent enough to pass the re-confirmation window. */
function fact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fact-1',
    profile_id: 'profile-1',
    canonical_key: 'sponsorship',
    category: 'work_authorization',
    question: 'Will you require sponsorship?',
    answer: 'No, I have OPT/EAD.',
    source: 'founder-direct',
    superseded_at: null,
    last_verified_at: new Date().toISOString(),
    ...overrides,
  }
}

beforeEach(() => {
  fake = baseline()
  discoverFields.mockReset()
  submit.mockReset()
  providerDryRun.mockReset()
  providerDryRun.mockResolvedValue({ outcome: 'ready', reason: 'ready' })
  canSubmit = false
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
    fake.tables.job_search_profile_facts.push(fact())
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'submitted', evidence: { confirmationId: 'gh-123', method: 'ats_api_response', receivedAt: '2026-01-01T00:00:00.000Z' }, response: { status: 200 } })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('submitted')
    const submittedRequest = submit.mock.calls[0][0]
    const filledAnswer = submittedRequest.answers.find((a: { field: { providerFieldId: string } }) => a.field.providerFieldId === 'question_555')
    expect(filledAnswer.value).toBe('No, I have OPT/EAD.')
  })

  it('an INFERRED (never verified) fact never auto-fills a high-risk field', async () => {
    fake.tables.job_search_profile_facts.push(fact({ id: 'fact-2', answer: 'Guessed answer', source: 'inferred' }))
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('needs_human')
    expect(submit).not.toHaveBeenCalled()
  })

  it('a superseded (no longer active) fact never auto-fills', async () => {
    fake.tables.job_search_profile_facts.push(fact({ id: 'fact-3', answer: 'stale', superseded_at: '2026-01-01T00:00:00.000Z' }))
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [sponsorshipField], domainValidations: [] })
    const result = await executeApplication('app-1')
    expect(result.outcome).toBe('needs_human')
  })
})

describe('executeApplication — dry run (#194 scenario 26)', () => {
  it('dry run never calls provider.submit and never reaches SUBMITTED', async () => {
    fake.tables.job_search_profile_facts.push(fact({ answer: 'No.' }))
    allowSubmission() // even with a submission-capable provider, dry run must not submit
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
    allowSubmission()
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
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'failed', reason: 'network error before dispatch', retryable: true })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('failed')
    expect(fake.tables.job_search_applications[0].status).toBe('PREPARED')
  })

  it('SUBMISSION_UNCERTAIN is never automatically retried by a second executeApplication call', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
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

describe('executeApplication — provider capability gate (post-audit)', () => {
  it('a provider that declares canSubmit=false is never asked to submit, even with automation on and dry run off', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    // canSubmit stays false — the real Greenhouse provider's actual value.
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'not_supported', reason: "requires the employer's own Job Board API key" })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('needs_human')
    expect(fake.tables.job_search_applications[0].status).toBe('NEEDS_HUMAN')
    // Never SUBMITTED, and the recorded attempt says needs_human, not submitted.
    expect(latestAttempt().outcome).toBe('needs_human')
    expect(latestAttempt().confirmation_evidence).toBeNull()
  })

  it('the founder-facing reason explains it is prepared, without leaking internals', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'not_supported', reason: "Greenhouse's submission endpoint requires the employer's own Job Board API key." })

    const result = await executeApplication('app-1')

    if (result.outcome !== 'needs_human') throw new Error('expected needs_human')
    expect(result.reason).toMatch(/API key/i)
    expect(result.reason).not.toMatch(/claim_token|supabase|job_search_|TTL/i)
  })
})

describe('executeApplication — rollout revalidation after the claim (TOCTOU, post-audit)', () => {
  // Preflight reads the kill switches before the claim; discovery then takes
  // real wall-clock time. Each of these flips a switch DURING that window and
  // asserts the switch still wins.
  function flipDuringDiscovery(patch: Record<string, unknown>) {
    discoverFields.mockImplementation(async () => {
      Object.assign(fake.tables.job_search_execution_settings[0], patch)
      return { outcome: 'clear', fields: [], domainValidations: [] }
    })
  }

  it('emergency pause issued between preflight and submit prevents submission', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    flipDuringDiscovery({ emergency_paused: true })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.reason).toMatch(/emergency-paused/i)
    expect(fake.tables.job_search_applications[0].status).toBe('NEEDS_HUMAN')
  })

  it('automation disabled between preflight and submit prevents submission', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    flipDuringDiscovery({ automation_enabled: false })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.reason).toMatch(/disabled/i)
  })

  it('dry run re-enabled between preflight and submit downgrades to a dry run — no real submission', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    flipDuringDiscovery({ dry_run: true })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.dryRun).toBe(true)
    expect(latestAttempt().dry_run).toBe(true)
  })
})

describe('executeApplication — a real submission is never reported without durable evidence (post-audit)', () => {
  it('a submission whose claim was reaped mid-flight reports uncertain, not submitted', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockImplementation(async () => {
      // Simulate the lease being reaped/stolen while the POST was in flight:
      // the token no longer matches, so the release will match zero rows.
      fake.tables.job_search_applications[0].execution_claim_token = null
      return { outcome: 'submitted', evidence: { confirmationId: 'gh-777', method: 'ats_api_response', receivedAt: '2026-01-01T00:00:00.000Z' }, response: { status: 200 } }
    })

    const result = await executeApplication('app-1')

    // We really did submit, but we could not finalize the row — reporting
    // "submitted" here would assert a state the database does not hold.
    expect(result.outcome).toBe('submission_uncertain')
    if (result.outcome === 'submission_uncertain') expect(result.reason).toMatch(/gh-777/)
    expect(fake.tables.job_search_applications[0].status).not.toBe('SUBMITTED')
  })

  it('the audit row is written BEFORE the status flip, so evidence can never be missing for a SUBMITTED row', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'submitted', evidence: { confirmationId: 'gh-555', method: 'ats_api_response', receivedAt: '2026-01-01T00:00:00.000Z' }, response: { status: 200 } })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('submitted')
    const app = fake.tables.job_search_applications[0]
    expect(app.status).toBe('SUBMITTED')
    const attempt = latestAttempt()
    expect(attempt.outcome).toBe('submitted')
    expect((attempt.confirmation_evidence as { confirmationId: string }).confirmationId).toBe('gh-555')
  })

  it('an uncertain submission consumes daily submission capacity (it may have reached the employer)', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'submission_uncertain', reason: 'connection reset' })

    await executeApplication('app-1')

    const app = fake.tables.job_search_applications[0]
    expect(app.status).toBe('SUBMISSION_UNCERTAIN')
    expect(app.submitted_at).toBeTruthy()
  })
})

describe('executeApplication — optional fields never block and are never auto-filled (post-audit)', () => {
  const optionalDemographic = { providerFieldId: 'question_eeoc', label: 'Gender', semanticKey: 'demographic', inputType: 'select' as const, required: false, allowedOptions: [{ label: 'Decline to self-identify', value: '3' }], confidence: 0.9 }

  it('an optional voluntary self-identification field is left blank, not escalated and not auto-filled', async () => {
    fake.tables.job_search_profile_facts.push(fact({ id: 'fact-demo', canonical_key: 'demographic', category: 'demographic', answer: 'Male' }))
    fake.tables.job_search_execution_settings[0].dry_run = false
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [optionalDemographic], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'submitted', evidence: { confirmationId: 'gh-1', method: 'ats_api_response', receivedAt: '2026-01-01T00:00:00.000Z' }, response: { status: 200 } })

    const result = await executeApplication('app-1')

    // Not a blocker...
    expect(result.outcome).toBe('submitted')
    // ...and never answered from a stored fact.
    const sent = submit.mock.calls[0][0]
    expect(sent.answers.some((a: { field: { providerFieldId: string } }) => a.field.providerFieldId === 'question_eeoc')).toBe(false)
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

/**
 * CAY-194 — readiness dry-run vs live submission are separate authorities.
 *
 * A dry-run runs on its own authority (so it works while the live-action
 * switch is off) and can never acquire submission authority — not from
 * `automation_enabled=true`, and not from a mid-flight settings flip.
 */
describe('executeApplication — dry-run authority is independent and non-escalating (CAY-194)', () => {
  function setMode(opts: { dryRun: boolean; automation: boolean }) {
    fake.tables.job_search_execution_settings[0].dry_run = opts.dryRun
    fake.tables.job_search_execution_settings[0].automation_enabled = opts.automation
  }

  function reservations() {
    return fake.tables.job_search_submission_reservations ?? []
  }

  // The exact bug: a founder-confirmed readiness dry-run blocked by the
  // live-action switch.
  it('a dry-run runs to completion while automation_enabled=false', async () => {
    setMode({ dryRun: true, automation: false })
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') {
      expect(result.reason).toBe('dry_run_ready')
      expect(result.dryRun).toBe(true)
    }
    expect(latestAttempt().dry_run).toBe(true)
  })

  // E — the readiness path goes through the separate dryRun contract only.
  it('E: a dry-run calls provider.dryRun and never provider.submit', async () => {
    setMode({ dryRun: true, automation: false })
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })

    await executeApplication('app-1')

    expect(providerDryRun).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledTimes(0)
  })

  // F — live automation being armed must not upgrade a dry-run.
  it('F: a dry-run stays non-submitting when automation_enabled=true and the provider CAN submit', async () => {
    setMode({ dryRun: true, automation: true })
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(providerDryRun).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.dryRun).toBe(true)
    expect(fake.tables.job_search_applications[0].status).toBe('NEEDS_HUMAN')
    expect(latestAttempt().dry_run).toBe(true)
  })

  // H — both modes withdrawn mid-flight stops the attempt.
  it('H: dry-run AND automation both switched off after the claim stops safely', async () => {
    setMode({ dryRun: true, automation: false })
    allowSubmission()
    discoverFields.mockImplementation(async () => {
      Object.assign(fake.tables.job_search_execution_settings[0], { dry_run: false, automation_enabled: false })
      return { outcome: 'clear', fields: [], domainValidations: [] }
    })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(providerDryRun).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.reason).toMatch(/both disabled/i)
    expect(fake.tables.job_search_applications[0].status).toBe('NEEDS_HUMAN')
    expect(reservations()).toHaveLength(0)
  })

  // Dry-run turned OFF mid-flight must not promote an in-flight readiness
  // pass into a live one, even with automation armed.
  it('dry-run switched off mid-flight cannot promote a readiness pass to live', async () => {
    setMode({ dryRun: true, automation: true })
    allowSubmission()
    discoverFields.mockImplementation(async () => {
      Object.assign(fake.tables.job_search_execution_settings[0], { dry_run: false })
      return { outcome: 'clear', fields: [], domainValidations: [] }
    })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.dryRun).toBe(true)
    expect(latestAttempt().dry_run).toBe(true)
    expect(reservations()).toHaveLength(0)
  })

  // G — emergency pause outranks the dry-run authority.
  it('G: emergency pause blocks a dry-run outright', async () => {
    setMode({ dryRun: true, automation: false })
    fake.tables.job_search_execution_settings[0].emergency_paused = true
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('preflight_blocked')
    expect(providerDryRun).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  // C/K — the cap bounds real submissions only.
  it('C+K: a dry-run runs at cap=0 and consumes no submission reservation', async () => {
    setMode({ dryRun: true, automation: false })
    fake.tables.job_search_execution_settings[0].daily_submission_cap = 0
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.reason).toBe('dry_run_ready')
    expect(reservations()).toHaveLength(0)
    expect(submit).not.toHaveBeenCalled()
  })

  // L — the live path's atomic reservation behavior is untouched.
  it('L: the live path still reserves a slot atomically before submitting', async () => {
    setMode({ dryRun: false, automation: true })
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    submit.mockResolvedValue({ outcome: 'submitted', response: {}, evidence: { confirmationId: 'conf-1' } })

    const result = await executeApplication('app-1')

    expect(submit).toHaveBeenCalledTimes(1)
    expect(providerDryRun).not.toHaveBeenCalled()
    expect(result.outcome).toBe('submitted')
    expect(reservations()).toHaveLength(1)
  })

  it('L2: the live path is blocked when no slot can be reserved, and never submits', async () => {
    setMode({ dryRun: false, automation: true })
    fake.tables.job_search_execution_settings[0].daily_submission_cap = 0
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(reservations()).toHaveLength(0)
    expect(result.outcome).toBe('preflight_blocked')
  })

  // A dry-run must never be able to write a submitted/uncertain terminal state.
  it('a dry-run never writes SUBMITTED or SUBMISSION_UNCERTAIN', async () => {
    for (const automation of [true, false]) {
      fake = baseline()
      providerDryRun.mockResolvedValue({ outcome: 'ready', reason: 'ready' })
      setMode({ dryRun: true, automation })
      allowSubmission()
      discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })

      const result = await executeApplication('app-1')

      expect(result.outcome).not.toBe('submitted')
      expect(result.outcome).not.toBe('submission_uncertain')
      expect(fake.tables.job_search_applications[0].status).toBe('NEEDS_HUMAN')
      expect(fake.tables.job_search_applications[0].submitted_at ?? null).toBeNull()
    }
  })

  // A blocked readiness pass is still a non-submitting one.
  it('a readiness pass that reports needs_human escalates without submitting', async () => {
    setMode({ dryRun: true, automation: true })
    allowSubmission()
    discoverFields.mockResolvedValue({ outcome: 'clear', fields: [], domainValidations: [] })
    providerDryRun.mockResolvedValue({ outcome: 'needs_human', reason: 'Resume upload control not found.' })

    const result = await executeApplication('app-1')

    expect(submit).not.toHaveBeenCalled()
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') expect(result.reason).toMatch(/Resume upload control/i)
    expect(reservations()).toHaveLength(0)
  })
})
