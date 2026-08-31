import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const env = {
  policy: {} as Record<string, unknown>,
  rollout: {} as Record<string, unknown>,
  settings: { paused: false },
  submittedToday: 0,
  granted: [] as Record<string, unknown>[],
  batch: { attempted: 0, submitted: 0, uncertain: 0, needsHuman: 0, failed: 0, skipped: [] as { applicationId: string; reason: string }[], stoppedEarly: null as string | null, results: [] as Record<string, unknown>[], authorizationId: 'auth-1' },
  paused: [] as string[],
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ in: () => ({ gte: async () => ({ count: env.submittedToday, error: null }) }) }),
    }),
  }),
}))

vi.mock('../standing-authorization', async () => {
  const actual = await vi.importActual<typeof import('../standing-authorization')>('../standing-authorization')
  return {
    ...actual,
    getStandingAuthorization: async () => env.policy,
    pauseStandingAuthorization: async (reason: string) => { env.paused.push(reason) },
  }
})
vi.mock('./rollout', async () => {
  const actual = await vi.importActual<typeof import('./rollout')>('./rollout')
  return {
    ...actual,
    getExecutionRolloutSettings: async () => env.rollout,
    getRemainingDailySubmissionCapacity: async () => (env.rollout.dailySubmissionCap as number) - env.submittedToday,
  }
})
vi.mock('../settings', () => ({ getJobSearchSettings: async () => env.settings }))
vi.mock('../events', () => ({ logJobSearchEvent: async () => {} }))
vi.mock('./batch', async () => {
  const actual = await vi.importActual<typeof import('./batch')>('./batch')
  return {
    ...actual,
    grantBatchAuthorization: async (input: Record<string, unknown>) => {
      env.granted.push(input)
      return { ok: true, authorization: { id: 'auth-1', ...input } }
    },
    runAuthorizedBatch: async () => env.batch,
  }
})

import { runStandingAutonomyCycle } from './autonomy'

function activePolicy(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true, revokedAt: null, pausedAt: null, pausedReason: null,
    minFitScore: 70, maxApplicationsPerDay: 150, allowedJobFamilies: [],
    allowedProviders: ['greenhouse'], excludedEmployers: [],
    pauseOnSubmissionUncertain: true, useVerifiedFactsOnly: true,
    authorizedAt: '2026-08-31T00:00:00Z', authorizedBy: 'founder', evidence: {},
    ...overrides,
  }
}

beforeEach(() => {
  env.policy = activePolicy()
  env.rollout = { automationEnabled: true, dryRun: false, dailySubmissionCap: 150, allowlistedProviders: ['greenhouse'], allowlistedEmployerDomains: [], emergencyPaused: false }
  env.settings = { paused: false }
  env.submittedToday = 0
  env.granted = []
  env.paused = []
  env.batch = { attempted: 2, submitted: 2, uncertain: 0, needsHuman: 0, failed: 0, skipped: [], stoppedEarly: null, results: [], authorizationId: 'auth-1' }
})

describe('the scheduler runs without a founder message', () => {
  it('submits under standing authorization with no new confirmation', async () => {
    const result = await runStandingAutonomyCycle()
    expect(result.status).toBe('ran')
    expect(result.batch?.submitted).toBe(2)
    // The envelope was minted server-side from policy, not by a founder turn.
    expect(env.granted[0]).toMatchObject({ actor: 'standing-authorization', minScore: 70 })
  })

  it('mints the envelope from durable policy, never from a caller argument', async () => {
    env.policy = activePolicy({ minFitScore: 85, allowedJobFamilies: ['software engineer'] })
    await runStandingAutonomyCycle()
    expect(env.granted[0]).toMatchObject({ minScore: 85, allowedJobFamilies: ['software engineer'] })
  })
})

describe('kill switches outrank standing authorization', () => {
  it('emergency pause wins', async () => {
    env.rollout = { ...env.rollout, emergencyPaused: true }
    const result = await runStandingAutonomyCycle()
    expect(result.status).toBe('idle')
    expect(result.reason).toContain('emergency-paused')
    expect(env.granted).toHaveLength(0)
  })

  it('the job-search pipeline pause wins', async () => {
    env.settings = { paused: true }
    expect((await runStandingAutonomyCycle()).status).toBe('idle')
    expect(env.granted).toHaveLength(0)
  })

  it('the global automation kill switch wins', async () => {
    env.rollout = { ...env.rollout, automationEnabled: false }
    const result = await runStandingAutonomyCycle()
    expect(result.status).toBe('idle')
    expect(env.granted).toHaveLength(0)
  })

  it('dry-run mode wins', async () => {
    env.rollout = { ...env.rollout, dryRun: true }
    expect((await runStandingAutonomyCycle()).status).toBe('idle')
    expect(env.granted).toHaveLength(0)
  })

  it('a paused standing authorization stops the worker immediately', async () => {
    env.policy = activePolicy({ pausedAt: '2026-08-31T10:00:00Z', pausedReason: 'founder paused' })
    const result = await runStandingAutonomyCycle()
    expect(result.status).toBe('idle')
    expect(env.granted).toHaveLength(0)
  })

  it('a revoked authorization stops the worker', async () => {
    env.policy = activePolicy({ revokedAt: '2026-08-31T10:00:00Z' })
    expect((await runStandingAutonomyCycle()).status).toBe('idle')
  })

  it('does nothing when there is no standing authorization at all', async () => {
    env.policy = activePolicy({ enabled: false })
    const result = await runStandingAutonomyCycle()
    expect(result.status).toBe('idle')
    expect(env.granted).toHaveLength(0)
  })
})

describe('capacity is the lowest of every ceiling', () => {
  it('is bounded by the staged rollout cap, not the founder ceiling', async () => {
    // "150 a day" must not outrank a rollout cap of 1 that exists because no
    // real submission has been confirmed yet.
    env.rollout = { ...env.rollout, dailySubmissionCap: 1 }
    await runStandingAutonomyCycle()
    expect(env.granted[0].maxApplications).toBe(1)
  })

  it('is bounded by the standing daily ceiling', async () => {
    env.policy = activePolicy({ maxApplicationsPerDay: 5 })
    await runStandingAutonomyCycle()
    expect(env.granted[0].maxApplications).toBe(5)
  })

  it('accounts for what was already submitted today', async () => {
    env.policy = activePolicy({ maxApplicationsPerDay: 10 })
    env.submittedToday = 7
    await runStandingAutonomyCycle()
    expect(env.granted[0].maxApplications).toBe(3)
  })

  it('does nothing once the daily ceiling is reached', async () => {
    env.policy = activePolicy({ maxApplicationsPerDay: 5 })
    env.submittedToday = 5
    const result = await runStandingAutonomyCycle()
    expect(result.status).toBe('idle')
    expect(result.capacity).toBe(0)
    expect(env.granted).toHaveLength(0)
  })

  it('treats the ceiling as a ceiling, never a quota', async () => {
    // Only 2 qualified applications existed; the cycle submits 2 of a 150 cap
    // and does not lower standards to fill the rest.
    env.batch = { ...env.batch, attempted: 2, submitted: 2 }
    const result = await runStandingAutonomyCycle()
    expect(result.batch?.submitted).toBe(2)
    expect(env.granted[0].minScore).toBe(70)
  })
})

describe('an uncertain submission stops autonomous submitting', () => {
  it('pauses the standing authorization after an uncertain outcome', async () => {
    env.batch = { ...env.batch, attempted: 1, submitted: 0, uncertain: 1 }
    const result = await runStandingAutonomyCycle()
    expect(result.pausedByUncertainty).toBe(true)
    expect(env.paused[0]).toContain('UNCERTAIN')
  })

  it('does not retry automatically — the next cycle finds it paused', async () => {
    env.batch = { ...env.batch, uncertain: 1 }
    await runStandingAutonomyCycle()
    env.policy = activePolicy({ pausedAt: '2026-08-31T10:00:00Z', pausedReason: 'uncertain' })
    const second = await runStandingAutonomyCycle()
    expect(second.status).toBe('idle')
  })

  it('does not pause on an ordinary skip, so the queue keeps moving', async () => {
    env.batch = { ...env.batch, attempted: 3, submitted: 2, uncertain: 0, skipped: [{ applicationId: 'a', reason: 'below threshold' }] }
    const result = await runStandingAutonomyCycle()
    expect(result.pausedByUncertainty).toBeFalsy()
    expect(env.paused).toHaveLength(0)
    expect(result.batch?.submitted).toBe(2)
  })

  it('does not pause when the founder turned that behavior off', async () => {
    env.policy = activePolicy({ pauseOnSubmissionUncertain: false })
    env.batch = { ...env.batch, uncertain: 1 }
    const result = await runStandingAutonomyCycle()
    expect(result.pausedByUncertainty).toBe(false)
  })
})
