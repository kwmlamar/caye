import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const state: { row: Record<string, unknown> | null; updates: Record<string, unknown>[]; readError: boolean } = {
  row: null,
  updates: [],
  readError: false,
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => (state.readError ? { data: null, error: { message: 'boom' } } : { data: state.row, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        state.updates.push(patch)
        if (state.row) Object.assign(state.row, patch)
        return { eq: async () => ({ error: null }) }
      },
    }),
  }),
}))
vi.mock('./events', () => ({ logJobSearchEvent: async () => {} }))

import {
  getStandingAuthorization,
  grantStandingAuthorization,
  pauseStandingAuthorization,
  resumeStandingAuthorization,
  revokeStandingAuthorization,
  updateStandingPolicy,
  isStandingAuthorizationActive,
  standingAuthorizationDenial,
} from './standing-authorization'

function seed(overrides: Record<string, unknown> = {}) {
  state.row = {
    standing_authorization_enabled: false,
    standing_authorized_at: null,
    standing_authorized_by: null,
    standing_authorization_evidence: {},
    standing_revoked_at: null,
    standing_paused_at: null,
    standing_paused_reason: null,
    standing_min_fit_score: 70,
    standing_max_applications_per_day: 150,
    standing_allowed_job_families: [],
    standing_allowed_providers: ['greenhouse'],
    standing_excluded_employers: [],
    standing_pause_on_submission_uncertain: true,
    standing_use_verified_facts_only: true,
    ...overrides,
  }
}

beforeEach(() => { state.updates = []; state.readError = false; seed() })

describe('standing authorization is durable server-side state', () => {
  it('is inactive until explicitly granted', async () => {
    expect(isStandingAuthorizationActive(await getStandingAuthorization())).toBe(false)
  })

  it('fails closed when the policy row cannot be read', async () => {
    state.readError = true
    const policy = await getStandingAuthorization()
    expect(isStandingAuthorizationActive(policy)).toBe(false)
    // Fail-closed must be restrictive in every field, not just the flag.
    expect(policy.maxApplicationsPerDay).toBe(0)
    expect(policy.minFitScore).toBe(100)
    expect(policy.useVerifiedFactsOnly).toBe(true)
  })

  it('records the founder instruction as authorization evidence', async () => {
    const granted = await grantStandingAuthorization({
      actor: 'founder',
      instruction: 'Start applying for jobs for me. Up to 150 a day.',
    })
    expect(granted.ok).toBe(true)
    const policy = await getStandingAuthorization()
    expect(policy.evidence.instruction).toBe('Start applying for jobs for me. Up to 150 a day.')
    expect(policy.authorizedBy).toBe('founder')
    expect(isStandingAuthorizationActive(policy)).toBe(true)
  })

  it('refuses a grant with no recorded founder instruction', async () => {
    const granted = await grantStandingAuthorization({ actor: 'founder', instruction: '   ' })
    expect(granted).toMatchObject({ ok: false })
    expect(state.updates).toHaveLength(0)
  })

  it('replaces the three-step activation ritual with one instruction', async () => {
    await grantStandingAuthorization({ actor: 'founder', instruction: 'Start applying for jobs for me.' })
    const patch = state.updates[0]
    // What used to be "enable automation" (yes) + "disable dry run" (yes).
    expect(patch.automation_enabled).toBe(true)
    expect(patch.dry_run).toBe(false)
    expect(patch.standing_authorization_enabled).toBe(true)
  })
})

describe('caps and thresholds cannot be talked past', () => {
  it('refuses a daily ceiling above the hard rollout maximum', async () => {
    const granted = await grantStandingAuthorization({ actor: 'founder', instruction: 'apply', maxApplicationsPerDay: 5000 })
    expect(granted).toMatchObject({ ok: false })
    expect(state.updates).toHaveLength(0)
  })

  it('refuses a nonsensical fit threshold', async () => {
    expect(await grantStandingAuthorization({ actor: 'founder', instruction: 'apply', minFitScore: 500 })).toMatchObject({ ok: false })
    expect(await updateStandingPolicy({ minFitScore: -1 }, 'founder')).toMatchObject({ ok: false })
  })

  it('refuses to raise the daily ceiling past the maximum after the fact', async () => {
    await grantStandingAuthorization({ actor: 'founder', instruction: 'apply' })
    expect(await updateStandingPolicy({ maxApplicationsPerDay: 1000 }, 'founder')).toMatchObject({ ok: false })
  })

  it('accepts the founder target of 150 per day', async () => {
    const granted = await grantStandingAuthorization({ actor: 'founder', instruction: 'apply', maxApplicationsPerDay: 150 })
    expect(granted).toMatchObject({ ok: true })
    expect((await getStandingAuthorization()).maxApplicationsPerDay).toBe(150)
  })
})

describe('pause, resume, stop', () => {
  it('pauses immediately while keeping the authorization', async () => {
    await grantStandingAuthorization({ actor: 'founder', instruction: 'apply' })
    await pauseStandingAuthorization('founder asked', 'founder')
    const policy = await getStandingAuthorization()
    expect(isStandingAuthorizationActive(policy)).toBe(false)
    expect(policy.enabled).toBe(true)
    expect(standingAuthorizationDenial(policy)).toContain('paused')
  })

  it('resumes after a pause', async () => {
    await grantStandingAuthorization({ actor: 'founder', instruction: 'apply' })
    await pauseStandingAuthorization('founder asked', 'founder')
    expect(await resumeStandingAuthorization('founder')).toMatchObject({ ok: true })
    expect(isStandingAuthorizationActive(await getStandingAuthorization())).toBe(true)
  })

  it('refuses to resume an authorization that was stopped rather than paused', async () => {
    await grantStandingAuthorization({ actor: 'founder', instruction: 'apply' })
    await revokeStandingAuthorization('founder', 'stop applying')
    expect(await resumeStandingAuthorization('founder')).toMatchObject({ ok: false })
    expect(isStandingAuthorizationActive(await getStandingAuthorization())).toBe(false)
  })

  it('turns live submission back off when stopped', async () => {
    await grantStandingAuthorization({ actor: 'founder', instruction: 'apply' })
    state.updates = []
    await revokeStandingAuthorization('founder', 'stop applying')
    const patch = state.updates[0]
    expect(patch.automation_enabled).toBe(false)
    expect(patch.dry_run).toBe(true)
    expect(patch.standing_authorization_enabled).toBe(false)
  })

  it('a revoked authorization stays inactive even if the paused flag is clear', async () => {
    seed({ standing_authorization_enabled: true, standing_revoked_at: '2026-08-31T00:00:00Z', standing_paused_at: null })
    expect(isStandingAuthorizationActive(await getStandingAuthorization())).toBe(false)
  })
})

describe('policy edits', () => {
  it('applies the founder\'s spoken policy changes', async () => {
    await grantStandingAuthorization({ actor: 'founder', instruction: 'apply' })
    expect(await updateStandingPolicy({ minFitScore: 80 }, 'founder')).toMatchObject({ ok: true })
    expect((await getStandingAuthorization()).minFitScore).toBe(80)

    await updateStandingPolicy({ allowedJobFamilies: ['software engineer'] }, 'founder')
    expect((await getStandingAuthorization()).allowedJobFamilies).toEqual(['software engineer'])
  })

  it('rejects an empty policy change instead of writing nothing quietly', async () => {
    expect(await updateStandingPolicy({}, 'founder')).toMatchObject({ ok: false })
  })
})
