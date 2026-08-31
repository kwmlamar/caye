import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const { runPreflight } = await import('./preflight')

const GREENHOUSE_URL = 'https://job-boards.greenhouse.io/exampleco/jobs/12345'
const LINKEDIN_URL = 'https://www.linkedin.com/jobs/view/999'
const INDEED_URL = 'https://apply.indeed.com/apply/abc'

function baseline() {
  return makeFakeSupabase({
    job_search_settings: [{ id: true, paused: false, daily_application_cap: 150, minimum_queue_score: 70 }],
    job_search_execution_settings: [
      { id: true, automation_enabled: true, dry_run: true, daily_submission_cap: 3, allowlisted_providers: ['greenhouse'], allowlisted_employer_domains: [], emergency_paused: false },
    ],
    job_search_applications: [{ id: 'app-1', status: 'PREPARED', candidate_id: 'cand-1', resume_variant_id: 'variant-1', execution_attempt_count: 0 }],
    job_search_candidates: [{ id: 'cand-1', apply_url: GREENHOUSE_URL, company: 'Example Co', status: 'QUEUED' }],
    job_search_profiles: [{ id: 'profile-1', status: 'verified', contact_email: 'lamar@example.com', created_at: '2026-01-01T00:00:00.000Z' }],
    job_search_resume_variants: [{ id: 'variant-1', status: 'verified' }],
    job_search_generated_artifacts: [{ id: 'artifact-1', application_id: 'app-1', artifact_type: 'resume', resume_variant_id: 'variant-1', content: 'Real tailored resume content.', created_at: '2026-01-01T00:00:00.000Z' }],
    job_search_application_answers: [],
  })
}

beforeEach(() => {
  fake = baseline()
})

describe('runPreflight — clear path (#194)', () => {
  it('returns clear when every check passes', async () => {
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('clear')
    if (result.outcome === 'clear') {
      expect(result.context.provider).toBe('greenhouse')
      expect(result.context.dryRun).toBe(true)
    }
  })
})

describe('runPreflight — prohibited platforms (#194 scenarios 2 & 3)', () => {
  it('blocks a LinkedIn apply URL', async () => {
    fake.tables.job_search_candidates[0].apply_url = LINKEDIN_URL
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/LinkedIn|Indeed/i)
  })

  it('blocks an Indeed apply URL', async () => {
    fake.tables.job_search_candidates[0].apply_url = INDEED_URL
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })
})

describe('runPreflight — pause/rollout gates (#194 scenarios 11, 12, 13)', () => {
  it('blocks when job-search is paused', async () => {
    fake.tables.job_search_settings[0].paused = true
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/paused/i)
  })

  it('blocks when neither execution mode is open (dry-run off, automation off)', async () => {
    fake.tables.job_search_execution_settings[0].automation_enabled = false
    fake.tables.job_search_execution_settings[0].dry_run = false
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/both disabled/i)
  })

  it('blocks when emergency-paused', async () => {
    fake.tables.job_search_execution_settings[0].emergency_paused = true
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })

  it('blocks a LIVE attempt when the daily submission cap is already reached', async () => {
    // The cap is a real-submission cap, so it only gates the live mode.
    fake.tables.job_search_execution_settings[0].dry_run = false
    fake.tables.job_search_execution_settings[0].automation_enabled = true
    const todayIso = new Date().toISOString()
    fake.tables.job_search_applications.push({ id: 'other-1', status: 'SUBMITTED', submitted_at: todayIso }, { id: 'other-2', status: 'SUBMITTED', submitted_at: todayIso }, { id: 'other-3', status: 'SUBMITTED', submitted_at: todayIso })
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/cap/i)
  })

  it('blocks when the provider is not allowlisted', async () => {
    fake.tables.job_search_execution_settings[0].allowlisted_providers = []
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/allowlist/i)
  })

  it('blocks when an employer allowlist is configured and this employer is not on it', async () => {
    fake.tables.job_search_execution_settings[0].allowlisted_employer_domains = ['othercompany.com']
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })
})

describe('runPreflight — already-handled applications never re-attempt (#194 scenarios 18 & 21)', () => {
  it('blocks an already-SUBMITTED application', async () => {
    fake.tables.job_search_applications[0].status = 'SUBMITTED'
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })

  it('blocks a SUBMISSION_UNCERTAIN application — never automatically retried', async () => {
    fake.tables.job_search_applications[0].status = 'SUBMISSION_UNCERTAIN'
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/uncertain/i)
  })

  it('blocks an application currently APPLYING (already claimed)', async () => {
    fake.tables.job_search_applications[0].status = 'APPLYING'
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })
})

describe('runPreflight — verification/artifact gates (#194 scenario 10 and founder-profile checks)', () => {
  it('blocks when the founder profile is not verified', async () => {
    fake.tables.job_search_profiles[0].status = 'needs_verification'
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })

  it('blocks when the founder profile has no contact email', async () => {
    fake.tables.job_search_profiles[0].contact_email = null
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/contact_email|contact email/i)
  })

  it('blocks when the resume variant is not verified', async () => {
    fake.tables.job_search_resume_variants[0].status = 'needs_verification'
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })

  it('blocks when no resume artifact exists for THIS application — never falls back to another application\'s artifact', async () => {
    fake.tables.job_search_generated_artifacts = fake.tables.job_search_generated_artifacts.filter((a) => a.application_id !== 'app-1')
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/artifact/i)
  })

  it('a resume artifact belonging to a DIFFERENT application is never picked up', async () => {
    fake.tables.job_search_generated_artifacts = [{ id: 'other-artifact', application_id: 'app-999', artifact_type: 'resume', resume_variant_id: 'variant-1', content: 'wrong content', created_at: '2026-01-01T00:00:00.000Z' }]
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
  })

  it('a resume artifact tied to a DIFFERENT resume_variant_id than the application specifies is refused, even if it references the right application_id', async () => {
    fake.tables.job_search_generated_artifacts[0].resume_variant_id = 'some-other-variant'
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/mismatched|different resume_variant_id/i)
  })

  it('blocks when there is an unresolved required-field blocker left over from preparation', async () => {
    fake.tables.job_search_application_answers.push({ id: 'ans-1', application_id: 'app-1', question: 'Will you require sponsorship?', answer: null, answer_source: 'needs_human' })
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/sponsorship/i)
  })
})

/**
 * CAY-194 — readiness dry-run vs live submission are separate authorities.
 *
 * `automation_enabled` governs the consequential act of submitting a real
 * application. It must not gate the structurally non-submitting readiness
 * path. The matrix below is the whole contract; emergency pause outranks
 * every cell in it.
 */
describe('runPreflight — execution-mode authority matrix (CAY-194)', () => {
  function setMode(opts: { dryRun: boolean; automation: boolean }) {
    fake.tables.job_search_execution_settings[0].dry_run = opts.dryRun
    fake.tables.job_search_execution_settings[0].automation_enabled = opts.automation
  }

  function fillDailyCap() {
    const todayIso = new Date().toISOString()
    fake.tables.job_search_applications.push(
      { id: 'cap-1', status: 'SUBMITTED', submitted_at: todayIso },
      { id: 'cap-2', status: 'SUBMITTED', submitted_at: todayIso },
      { id: 'cap-3', status: 'SUBMITTED', submitted_at: todayIso },
    )
  }

  // A — the exact bug this change fixes.
  it('A: dry_run=true + automation_enabled=false => clear', async () => {
    setMode({ dryRun: true, automation: false })
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('clear')
    if (result.outcome === 'clear') {
      expect(result.context.dryRun).toBe(true)
      expect(result.checks.find((c) => c.key === 'execution_mode_allowed')?.passed).toBe(true)
    }
  })

  // B — live mode with the live switch off stays blocked.
  it('B: dry_run=false + automation_enabled=false => blocked', async () => {
    setMode({ dryRun: false, automation: false })
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') {
      expect(result.checks.find((c) => c.key === 'execution_mode_allowed')?.passed).toBe(false)
    }
  })

  // C — the cap is a real-submission cap and must not gate readiness.
  it('C: dry_run=true + automation_enabled=false + cap exhausted => still clear', async () => {
    setMode({ dryRun: true, automation: false })
    fillDailyCap()
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('clear')
    if (result.outcome === 'clear') {
      expect(result.checks.find((c) => c.key === 'daily_cap_remaining')?.passed).toBe(true)
    }
  })

  it('C2: dry_run=true still clear when the configured cap is literally 0', async () => {
    setMode({ dryRun: true, automation: false })
    fake.tables.job_search_execution_settings[0].daily_submission_cap = 0
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('clear')
  })

  // D — the live path's existing cap policy is untouched.
  it('D: dry_run=false + automation_enabled=true + cap 0 => blocked on capacity', async () => {
    setMode({ dryRun: false, automation: true })
    fake.tables.job_search_execution_settings[0].daily_submission_cap = 0
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toMatch(/cap/i)
  })

  it('dry_run=true + automation_enabled=true => clear, and still marked as a dry-run', async () => {
    setMode({ dryRun: true, automation: true })
    const result = await runPreflight('app-1')
    expect(result.outcome).toBe('clear')
    // Live automation being on must not turn the readiness pass into a live one.
    if (result.outcome === 'clear') expect(result.context.dryRun).toBe(true)
  })

  // G — emergency pause outranks every cell of the matrix.
  it('G: emergency pause blocks a dry-run regardless of the other switches', async () => {
    for (const dryRun of [true, false]) {
      for (const automation of [true, false]) {
        fake = baseline()
        setMode({ dryRun, automation })
        fake.tables.job_search_execution_settings[0].emergency_paused = true
        const result = await runPreflight('app-1')
        expect(result.outcome).toBe('blocked')
        if (result.outcome === 'blocked') expect(result.reason).toMatch(/emergency/i)
      }
    }
  })

  it('every non-mode safety gate still blocks a dry-run', async () => {
    const cases: Array<[string, () => void, RegExp]> = [
      ['prohibited destination', () => { fake.tables.job_search_candidates[0].apply_url = LINKEDIN_URL }, /LinkedIn|Indeed/i],
      ['job-search paused', () => { fake.tables.job_search_settings[0].paused = true }, /paused/i],
      ['provider not allowlisted', () => { fake.tables.job_search_execution_settings[0].allowlisted_providers = [] }, /allowlist/i],
      ['employer not allowlisted', () => { fake.tables.job_search_execution_settings[0].allowlisted_employer_domains = ['othercompany.com'] }, /allowlist/i],
      ['profile unverified', () => { fake.tables.job_search_profiles[0].status = 'draft' }, /profile/i],
      ['resume variant unverified', () => { fake.tables.job_search_resume_variants[0].status = 'draft' }, /resume variant/i],
      ['not PREPARED', () => { fake.tables.job_search_applications[0].status = 'APPLYING' }, /PREPARED/i],
    ]
    for (const [label, mutate, expected] of cases) {
      fake = baseline()
      setMode({ dryRun: true, automation: false })
      mutate()
      const result = await runPreflight('app-1')
      expect(result.outcome, label).toBe('blocked')
      if (result.outcome === 'blocked') expect(result.reason, label).toMatch(expected)
    }
  })
})
