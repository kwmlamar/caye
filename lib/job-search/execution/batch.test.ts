import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const executeApplication = vi.fn()
vi.mock('./executor', () => ({ executeApplication: (...args: unknown[]) => executeApplication(...args) }))

const { runAuthorizedBatch, grantBatchAuthorization, revokeBatchAuthorization, selectBatchCandidates, MAX_BATCH_CONCURRENCY } = await import('./batch')

const GH = (n: number) => `https://job-boards.greenhouse.io/exampleco/jobs/${n}`

function authorization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'auth-1',
    created_by: 'founder',
    provider: 'greenhouse',
    max_applications: 5,
    min_score: 70,
    allowed_job_families: [],
    consumed_count: 0,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    revoked_at: null,
    ...overrides,
  }
}

function baseline(applicationCount = 3) {
  const applications = []
  const candidates = []
  for (let i = 1; i <= applicationCount; i++) {
    applications.push({ id: `app-${i}`, status: 'PREPARED', candidate_id: `cand-${i}`, resume_variant_id: 'variant-1' })
    candidates.push({ id: `cand-${i}`, apply_url: GH(1000 + i), company: `Co ${i}`, title: 'Software Engineer I', fit_score: 80, status: 'QUEUED' })
  }
  return makeFakeSupabase({
    job_search_settings: [{ id: true, paused: false, daily_application_cap: 150, minimum_queue_score: 70 }],
    job_search_execution_settings: [
      { id: true, automation_enabled: true, dry_run: false, daily_submission_cap: 150, allowlisted_providers: ['greenhouse'], allowlisted_employer_domains: [], emergency_paused: false },
    ],
    job_search_batch_authorizations: [authorization()],
    job_search_applications: applications,
    job_search_candidates: candidates,
  })
}

const FAST = { spacingMs: 0 }

beforeEach(() => {
  fake = baseline()
  executeApplication.mockReset()
  executeApplication.mockResolvedValue({ outcome: 'submitted', confirmationId: 'gh-1' })
})

describe('runAuthorizedBatch — the authorization envelope is a hard bound', () => {
  it('never exceeds the authorized application count', async () => {
    fake = baseline(10)
    fake.tables.job_search_batch_authorizations[0].max_applications = 3

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(3)
    expect(executeApplication).toHaveBeenCalledTimes(3)
  })

  it('respects an authorization that is already partly consumed', async () => {
    fake = baseline(10)
    fake.tables.job_search_batch_authorizations[0].max_applications = 5
    fake.tables.job_search_batch_authorizations[0].consumed_count = 3

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(2)
  })

  it('refuses an expired authorization', async () => {
    fake.tables.job_search_batch_authorizations[0].expires_at = new Date(Date.now() - 1000).toISOString()

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(0)
    expect(outcome.stoppedEarly).toMatch(/expired/i)
    expect(executeApplication).not.toHaveBeenCalled()
  })

  it('refuses a revoked authorization', async () => {
    fake.tables.job_search_batch_authorizations[0].revoked_at = new Date().toISOString()

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.stoppedEarly).toMatch(/revoked/i)
    expect(executeApplication).not.toHaveBeenCalled()
  })

  it('refuses a fully consumed authorization', async () => {
    fake.tables.job_search_batch_authorizations[0].consumed_count = 5

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.stoppedEarly).toMatch(/fully consumed/i)
    expect(executeApplication).not.toHaveBeenCalled()
  })

  it('refuses an unknown authorization', async () => {
    const outcome = await runAuthorizedBatch('does-not-exist', FAST)
    expect(outcome.stoppedEarly).toMatch(/does not exist/i)
    expect(executeApplication).not.toHaveBeenCalled()
  })

  it('cannot exceed the envelope even with concurrent workers', async () => {
    fake = baseline(10)
    fake.tables.job_search_batch_authorizations[0].max_applications = 4

    const outcome = await runAuthorizedBatch('auth-1', { concurrency: MAX_BATCH_CONCURRENCY, spacingMs: 0 })

    expect(outcome.attempted).toBe(4)
    expect(executeApplication).toHaveBeenCalledTimes(4)
    expect(fake.tables.job_search_batch_authorizations[0].consumed_count).toBe(4)
  })
})

describe('runAuthorizedBatch — policy is never relaxed to fill the batch', () => {
  it('skips applications below the authorized minimum score', async () => {
    fake = baseline(3)
    fake.tables.job_search_candidates[0].fit_score = 40
    fake.tables.job_search_candidates[1].fit_score = 55

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
  })

  it('submits fewer than authorized rather than reaching for unqualified jobs', async () => {
    fake = baseline(2)
    fake.tables.job_search_batch_authorizations[0].max_applications = 25

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(2)
    expect(outcome.submitted).toBe(2)
  })

  it('skips applications on a different provider than authorized', async () => {
    fake = baseline(2)
    fake.tables.job_search_candidates[0].apply_url = 'https://jobs.lever.co/exampleco/abc'

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
  })

  it('skips rejected candidates', async () => {
    fake = baseline(2)
    fake.tables.job_search_candidates[0].status = 'REJECTED'

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
  })

  it('honours a job-family restriction', async () => {
    fake = baseline(3)
    fake.tables.job_search_batch_authorizations[0].allowed_job_families = ['support engineer']
    fake.tables.job_search_candidates[0].title = 'Technical Support Engineer'

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
  })

  it('reports nothing to do when no application qualifies', async () => {
    fake = baseline(2)
    fake.tables.job_search_candidates.forEach((c) => { c.fit_score = 10 })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(0)
    expect(outcome.stoppedEarly).toMatch(/no PREPARED applications/i)
  })
})

describe('runAuthorizedBatch — resilience and stop conditions', () => {
  it('continues after an application that needs a human', async () => {
    fake = baseline(3)
    executeApplication
      .mockResolvedValueOnce({ outcome: 'needs_human', reason: 'Unresolved sponsorship question' })
      .mockResolvedValue({ outcome: 'submitted', confirmationId: 'gh-2' })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.needsHuman).toBe(1)
    expect(outcome.submitted).toBe(2)
    expect(outcome.attempted).toBe(3)
  })

  it('continues after one application throws — a bad application never kills the batch', async () => {
    fake = baseline(3)
    executeApplication
      .mockRejectedValueOnce(new Error('browser launch failed'))
      .mockResolvedValue({ outcome: 'submitted', confirmationId: 'gh-3' })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.failed).toBe(1)
    expect(outcome.submitted).toBe(2)
    expect(outcome.attempted).toBe(3)
  })

  it('STOPS the whole batch on an uncertain submission', async () => {
    fake = baseline(5)
    executeApplication
      .mockResolvedValueOnce({ outcome: 'submitted', confirmationId: 'gh-1' })
      .mockResolvedValueOnce({ outcome: 'submission_uncertain', reason: 'connection reset after click' })
      .mockResolvedValue({ outcome: 'submitted', confirmationId: 'gh-9' })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.uncertain).toBe(1)
    expect(outcome.attempted).toBe(2)
    expect(outcome.stoppedEarly).toMatch(/UNCERTAIN/i)
    expect(executeApplication).toHaveBeenCalledTimes(2)
  })

  it('stops when emergency pause is flipped mid-batch', async () => {
    fake = baseline(5)
    executeApplication.mockImplementationOnce(async () => {
      fake.tables.job_search_execution_settings[0].emergency_paused = true
      return { outcome: 'submitted', confirmationId: 'gh-1' }
    })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
    expect(outcome.stoppedEarly).toMatch(/emergency-paused/i)
  })

  it('stops when job search is paused mid-batch', async () => {
    fake = baseline(5)
    executeApplication.mockImplementationOnce(async () => {
      fake.tables.job_search_settings[0].paused = true
      return { outcome: 'submitted', confirmationId: 'gh-1' }
    })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
    expect(outcome.stoppedEarly).toMatch(/paused/i)
  })

  it('stops when live automation is switched off mid-batch', async () => {
    fake = baseline(5)
    executeApplication.mockImplementationOnce(async () => {
      fake.tables.job_search_execution_settings[0].automation_enabled = false
      return { outcome: 'submitted', confirmationId: 'gh-1' }
    })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
    expect(outcome.stoppedEarly).toMatch(/switched off/i)
  })

  it('stops when dry-run is switched on mid-batch', async () => {
    fake = baseline(5)
    executeApplication.mockImplementationOnce(async () => {
      fake.tables.job_search_execution_settings[0].dry_run = true
      return { outcome: 'submitted', confirmationId: 'gh-1' }
    })

    const outcome = await runAuthorizedBatch('auth-1', FAST)

    expect(outcome.attempted).toBe(1)
    expect(outcome.stoppedEarly).toMatch(/switched off/i)
  })

  it('never runs anything when execution is already emergency-paused', async () => {
    fake.tables.job_search_execution_settings[0].emergency_paused = true
    const outcome = await runAuthorizedBatch('auth-1', FAST)
    expect(executeApplication).not.toHaveBeenCalled()
    expect(outcome.attempted).toBe(0)
  })
})

describe('runAuthorizedBatch — concurrency is bounded', () => {
  it('never runs more than MAX_BATCH_CONCURRENCY workers, even if asked for more', async () => {
    fake = baseline(12)
    fake.tables.job_search_batch_authorizations[0].max_applications = 12

    let live = 0
    let peak = 0
    executeApplication.mockImplementation(async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live -= 1
      return { outcome: 'submitted', confirmationId: 'gh' }
    })

    await runAuthorizedBatch('auth-1', { concurrency: 50, spacingMs: 0 })

    expect(peak).toBeLessThanOrEqual(MAX_BATCH_CONCURRENCY)
  })

  it('defaults to a single worker', async () => {
    fake = baseline(4)
    let live = 0
    let peak = 0
    executeApplication.mockImplementation(async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 3))
      live -= 1
      return { outcome: 'submitted', confirmationId: 'gh' }
    })

    await runAuthorizedBatch('auth-1', FAST)

    expect(peak).toBe(1)
  })

  it('never submits the same application twice within a batch', async () => {
    fake = baseline(5)
    const seen: string[] = []
    executeApplication.mockImplementation(async (id: string) => {
      seen.push(id)
      return { outcome: 'submitted', confirmationId: 'gh' }
    })

    await runAuthorizedBatch('auth-1', { concurrency: 3, spacingMs: 0 })

    expect(new Set(seen).size).toBe(seen.length)
  })
})

describe('grantBatchAuthorization / revokeBatchAuthorization', () => {
  it('rejects a non-positive application count', async () => {
    const result = await grantBatchAuthorization({ provider: 'greenhouse', maxApplications: 0, actor: 'founder' })
    expect(result).toMatchObject({ ok: false })
  })

  it('creates an authorization with an expiry in the future', async () => {
    const result = await grantBatchAuthorization({ provider: 'greenhouse', maxApplications: 5, minScore: 70, actor: 'founder' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(Date.parse(result.authorization.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('a revoked authorization stops further submissions', async () => {
    await revokeBatchAuthorization('auth-1', 'founder')
    const outcome = await runAuthorizedBatch('auth-1', FAST)
    expect(outcome.stoppedEarly).toMatch(/revoked/i)
    expect(executeApplication).not.toHaveBeenCalled()
  })
})

describe('selectBatchCandidates — ranking', () => {
  it('returns the best-scoring qualified applications first', async () => {
    fake = baseline(3)
    fake.tables.job_search_candidates[0].fit_score = 72
    fake.tables.job_search_candidates[1].fit_score = 95
    fake.tables.job_search_candidates[2].fit_score = 84

    const selected = await selectBatchCandidates(
      { id: 'auth-1', provider: 'greenhouse', maxApplications: 3, minScore: 70, allowedJobFamilies: [], consumedCount: 0, expiresAt: new Date(Date.now() + 1000).toISOString(), revokedAt: null },
      3,
    )

    expect(selected.map((c) => c.fitScore)).toEqual([95, 84, 72])
  })
})

describe('runAuthorizedBatch — every batch submission traces to its authorization', () => {
  it('stamps the authorization id onto each execution', async () => {
    fake = baseline(2)
    const seen: unknown[] = []
    executeApplication.mockImplementation(async (_id: string, opts: unknown) => {
      seen.push(opts)
      return { outcome: 'submitted', confirmationId: 'gh' }
    })

    await runAuthorizedBatch('auth-1', FAST)

    expect(seen).toHaveLength(2)
    for (const opts of seen) expect(opts).toMatchObject({ batchAuthorizationId: 'auth-1' })
  })
})
