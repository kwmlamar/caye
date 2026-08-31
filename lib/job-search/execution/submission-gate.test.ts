import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const { checkSubmissionAuthority, authorizeSubmission, revalidateSubmissionAuthority } = await import('./submission-gate')

const APPLY_URL = 'https://job-boards.greenhouse.io/exampleco/jobs/12345'
const CLAIM = { applicationId: 'app-1', token: 'claim-token-1', attemptNumber: 1 }

function input(overrides: Record<string, unknown> = {}) {
  return {
    claim: CLAIM,
    provider: 'greenhouse' as const,
    applyUrl: APPLY_URL,
    company: 'Example Co',
    resumeArtifactId: 'artifact-1',
    resumeVariantId: 'variant-1',
    ...overrides,
  }
}

/** A world where a real submission IS authorized. Every test below removes exactly one thing. */
function baseline() {
  return makeFakeSupabase({
    job_search_settings: [{ id: true, paused: false, daily_application_cap: 150, minimum_queue_score: 70 }],
    job_search_execution_settings: [
      { id: true, automation_enabled: true, dry_run: false, daily_submission_cap: 3, allowlisted_providers: ['greenhouse'], allowlisted_employer_domains: [], emergency_paused: false },
    ],
    job_search_applications: [{ id: 'app-1', status: 'APPLYING', execution_claim_token: 'claim-token-1', candidate_id: 'cand-1', resume_variant_id: 'variant-1', execution_attempt_count: 1 }],
    job_search_candidates: [{ id: 'cand-1', apply_url: APPLY_URL, company: 'Example Co', status: 'QUEUED' }],
    job_search_profiles: [{ id: 'profile-1', status: 'verified', contact_email: 'lamar@example.com', created_at: '2026-01-01T00:00:00.000Z' }],
    job_search_resume_variants: [{ id: 'variant-1', status: 'verified' }],
    job_search_generated_artifacts: [{ id: 'artifact-1', application_id: 'app-1', artifact_type: 'resume', resume_variant_id: 'variant-1', content: 'Real tailored resume content.' }],
    job_search_application_answers: [],
    job_search_execution_attempts: [],
    job_search_submission_reservations: [],
  })
}

beforeEach(() => { fake = baseline() })

describe('checkSubmissionAuthority — the authorized baseline', () => {
  it('authorizes when every condition holds', async () => {
    await expect(checkSubmissionAuthority(input())).resolves.toEqual({ ok: true })
  })
})

describe('checkSubmissionAuthority — rollout kill switches', () => {
  it('refuses when emergency-paused', async () => {
    fake.tables.job_search_execution_settings[0].emergency_paused = true
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'emergency_paused' })
  })

  it('refuses when dry-run is active — a readiness pass may never submit', async () => {
    fake.tables.job_search_execution_settings[0].dry_run = true
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'dry_run_active' })
  })

  it('refuses when live automation is disabled', async () => {
    fake.tables.job_search_execution_settings[0].automation_enabled = false
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'automation_disabled' })
  })

  it('refuses when job search is paused', async () => {
    fake.tables.job_search_settings[0].paused = true
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'job_search_paused' })
  })

  it('refuses when the provider is not allowlisted', async () => {
    fake.tables.job_search_execution_settings[0].allowlisted_providers = []
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'provider_not_allowlisted' })
  })

  it('refuses a provider with no audited live path', async () => {
    const result = await checkSubmissionAuthority(input({ provider: 'lever' }))
    expect(result).toMatchObject({ ok: false, category: 'provider_unsupported' })
  })
})

describe('checkSubmissionAuthority — destination safety, revalidated from scratch', () => {
  it('refuses a non-Greenhouse host', async () => {
    const result = await checkSubmissionAuthority(input({ applyUrl: 'https://evil.example.com/apply' }))
    expect(result).toMatchObject({ ok: false, category: 'destination_rejected' })
  })

  it('refuses a prohibited platform', async () => {
    const result = await checkSubmissionAuthority(input({ applyUrl: 'https://www.linkedin.com/jobs/view/999' }))
    expect(result).toMatchObject({ ok: false })
  })

  it('refuses localhost and private destinations', async () => {
    for (const url of ['http://127.0.0.1:3000/apply', 'http://169.254.169.254/latest/meta-data', 'https://10.0.0.5/apply']) {
      const result = await checkSubmissionAuthority(input({ applyUrl: url }))
      expect(result).toMatchObject({ ok: false })
    }
  })

  it('refuses when the candidate apply URL changed after the attempt started', async () => {
    fake.tables.job_search_candidates[0].apply_url = 'https://job-boards.greenhouse.io/otherco/jobs/999'
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'destination_changed' })
  })

  it('refuses when an employer allowlist is configured and this employer is not on it', async () => {
    fake.tables.job_search_execution_settings[0].allowlisted_employer_domains = ['othercompany.com']
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'employer_not_allowlisted' })
  })
})

describe('checkSubmissionAuthority — claim ownership', () => {
  it('refuses when the application is no longer APPLYING', async () => {
    fake.tables.job_search_applications[0].status = 'NEEDS_HUMAN'
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'claim_lost' })
  })

  it('refuses when another attempt now holds the claim', async () => {
    fake.tables.job_search_applications[0].execution_claim_token = 'someone-elses-token'
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'claim_lost' })
  })

  it('refuses when the claim was reaped (token cleared)', async () => {
    fake.tables.job_search_applications[0].execution_claim_token = null
    const result = await checkSubmissionAuthority(input())
    expect(result).toMatchObject({ ok: false, category: 'claim_lost' })
  })
})

describe('checkSubmissionAuthority — identity, artifact binding, and unresolved answers', () => {
  it('refuses an unverified founder profile', async () => {
    fake.tables.job_search_profiles[0].status = 'draft'
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'profile_unverified' })
  })

  it('refuses a profile with no contact email', async () => {
    fake.tables.job_search_profiles[0].contact_email = ''
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'profile_incomplete' })
  })

  it('refuses an unverified resume variant', async () => {
    fake.tables.job_search_resume_variants[0].status = 'draft'
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'resume_unverified' })
  })

  it('refuses an artifact bound to a different application', async () => {
    fake.tables.job_search_generated_artifacts[0].application_id = 'app-2'
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'artifact_mismatch' })
  })

  it('refuses an artifact bound to a different resume variant', async () => {
    fake.tables.job_search_generated_artifacts[0].resume_variant_id = 'variant-9'
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'artifact_mismatch' })
  })

  it('refuses when the application now points at a different resume variant', async () => {
    fake.tables.job_search_applications[0].resume_variant_id = 'variant-9'
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'artifact_mismatch' })
  })

  it('refuses an empty resume artifact', async () => {
    fake.tables.job_search_generated_artifacts[0].content = '   '
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'artifact_empty' })
  })

  it('refuses when a required question is still unresolved — never guesses to proceed', async () => {
    fake.tables.job_search_application_answers.push({ id: 'ans-1', application_id: 'app-1', answer_source: 'needs_human', answer: null, question: 'Do you require sponsorship?' })
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'unresolved_answers' })
  })

  it('refuses a candidate that was rejected after preparation', async () => {
    fake.tables.job_search_candidates[0].status = 'REJECTED'
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'candidate_rejected' })
  })
})

describe('checkSubmissionAuthority — an application is never submitted twice', () => {
  it('refuses when a prior SUBMITTED attempt exists', async () => {
    fake.tables.job_search_execution_attempts.push({ id: 'att-1', application_id: 'app-1', outcome: 'submitted' })
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'already_submitted' })
  })

  it('refuses when a prior UNCERTAIN attempt exists — uncertainty is never resolved by re-sending', async () => {
    fake.tables.job_search_execution_attempts.push({ id: 'att-1', application_id: 'app-1', outcome: 'submission_uncertain' })
    expect(await checkSubmissionAuthority(input())).toMatchObject({ ok: false, category: 'already_submitted' })
  })

  it('is not blocked by a prior needs_human or failed attempt', async () => {
    fake.tables.job_search_execution_attempts.push(
      { id: 'att-1', application_id: 'app-1', outcome: 'needs_human' },
      { id: 'att-2', application_id: 'app-1', outcome: 'failed' },
    )
    expect(await checkSubmissionAuthority(input())).toEqual({ ok: true })
  })
})

describe('authorizeSubmission — the atomic daily reservation is taken last', () => {
  it('reserves a slot on success', async () => {
    const result = await authorizeSubmission(input())
    expect(result).toMatchObject({ ok: true })
    expect(fake.tables.job_search_submission_reservations).toHaveLength(1)
  })

  it('refuses when the daily cap is exhausted, and reserves nothing', async () => {
    fake.tables.job_search_execution_settings[0].daily_submission_cap = 0
    const result = await authorizeSubmission(input())
    expect(result).toMatchObject({ ok: false, category: 'daily_cap_reached' })
    expect(fake.tables.job_search_submission_reservations).toHaveLength(0)
  })

  it('never consumes capacity when an earlier check fails', async () => {
    fake.tables.job_search_execution_settings[0].emergency_paused = true
    await authorizeSubmission(input())
    expect(fake.tables.job_search_submission_reservations).toHaveLength(0)
  })

  it('cannot reserve twice for the same application (no duplicate submission)', async () => {
    const first = await authorizeSubmission(input())
    expect(first).toMatchObject({ ok: true })
    // Simulate a second worker on the same application under the same claim.
    const second = await authorizeSubmission(input())
    expect(second).toMatchObject({ ok: false })
    expect(fake.tables.job_search_submission_reservations).toHaveLength(1)
  })

  it('bounds concurrent reservations by the cap', async () => {
    fake.tables.job_search_execution_settings[0].daily_submission_cap = 2
    fake.tables.job_search_applications.push(
      { id: 'app-2', status: 'APPLYING', execution_claim_token: 't2', candidate_id: 'cand-1', resume_variant_id: 'variant-1' },
      { id: 'app-3', status: 'APPLYING', execution_claim_token: 't3', candidate_id: 'cand-1', resume_variant_id: 'variant-1' },
    )
    fake.tables.job_search_generated_artifacts.push(
      { id: 'artifact-2', application_id: 'app-2', artifact_type: 'resume', resume_variant_id: 'variant-1', content: 'x' },
      { id: 'artifact-3', application_id: 'app-3', artifact_type: 'resume', resume_variant_id: 'variant-1', content: 'x' },
    )

    const results = await Promise.all([
      authorizeSubmission(input()),
      authorizeSubmission(input({ claim: { applicationId: 'app-2', token: 't2', attemptNumber: 1 }, resumeArtifactId: 'artifact-2' })),
      authorizeSubmission(input({ claim: { applicationId: 'app-3', token: 't3', attemptNumber: 1 }, resumeArtifactId: 'artifact-3' })),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(fake.tables.job_search_submission_reservations).toHaveLength(2)
  })
})

describe('revalidateSubmissionAuthority — the last exit before the click', () => {
  it('passes when nothing changed', async () => {
    await expect(revalidateSubmissionAuthority(input())).resolves.toEqual({ ok: true })
  })

  it.each([
    ['emergency pause flipped on', () => { fake.tables.job_search_execution_settings[0].emergency_paused = true }],
    ['automation switched off', () => { fake.tables.job_search_execution_settings[0].automation_enabled = false }],
    ['dry-run switched on', () => { fake.tables.job_search_execution_settings[0].dry_run = true }],
    ['job search paused', () => { fake.tables.job_search_settings[0].paused = true }],
    ['claim lost', () => { fake.tables.job_search_applications[0].execution_claim_token = 'other' }],
    ['provider de-allowlisted', () => { fake.tables.job_search_execution_settings[0].allowlisted_providers = [] }],
    ['employer removed from allowlist', () => { fake.tables.job_search_execution_settings[0].allowlisted_employer_domains = ['nope.com'] }],
    ['destination changed', () => { fake.tables.job_search_candidates[0].apply_url = 'https://job-boards.greenhouse.io/x/jobs/1' }],
    ['candidate rejected', () => { fake.tables.job_search_candidates[0].status = 'REJECTED' }],
    ['artifact unbound', () => { fake.tables.job_search_generated_artifacts[0].resume_variant_id = 'variant-9' }],
  ])('stops immediately before the click when %s', async (_label, mutate) => {
    mutate()
    const result = await revalidateSubmissionAuthority(input())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/immediately before the submit click/i)
  })
})
