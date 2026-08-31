import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const { MAX_DAILY_SUBMISSION_CAP, ROLLOUT_STAGES, nextRolloutStage, getExecutionRolloutSettings, setAutomationEnabled, setDryRun, setDailySubmissionCap, setEmergencyPaused, getRemainingDailySubmissionCapacity } = await import('./rollout')

const DEFAULT_ROW = {
  id: true,
  automation_enabled: false,
  dry_run: true,
  daily_submission_cap: 3,
  allowlisted_providers: ['greenhouse'],
  allowlisted_employer_domains: [],
  emergency_paused: false,
}

beforeEach(() => {
  fake = makeFakeSupabase({ job_search_execution_settings: [{ ...DEFAULT_ROW }], job_search_applications: [] })
})

describe('getExecutionRolloutSettings (#194)', () => {
  it('reads the seeded fully-disabled defaults', async () => {
    const settings = await getExecutionRolloutSettings()
    expect(settings.automationEnabled).toBe(false)
    expect(settings.dryRun).toBe(true)
    expect(settings.dailySubmissionCap).toBe(3)
    expect(settings.emergencyPaused).toBe(false)
  })

  it('fails closed (maximally restricted) if the settings row cannot be read', async () => {
    fake = makeFakeSupabase({}) // no row at all
    const settings = await getExecutionRolloutSettings()
    expect(settings.automationEnabled).toBe(false)
    expect(settings.emergencyPaused).toBe(true)
    expect(settings.dailySubmissionCap).toBe(0)
  })
})

describe('rollout setters (#194)', () => {
  it('setAutomationEnabled flips the flag', async () => {
    await setAutomationEnabled(true, 'founder')
    expect((await getExecutionRolloutSettings()).automationEnabled).toBe(true)
  })

  it('setDryRun flips the flag', async () => {
    await setDryRun(false, 'founder')
    expect((await getExecutionRolloutSettings()).dryRun).toBe(false)
  })

  it('setDailySubmissionCap rejects a negative cap', async () => {
    await expect(setDailySubmissionCap(-1, 'founder')).rejects.toThrow()
  })

  it('setDailySubmissionCap rejects a non-integer cap', async () => {
    await expect(setDailySubmissionCap(2.5, 'founder')).rejects.toThrow()
  })

  it('setEmergencyPaused flips the flag', async () => {
    await setEmergencyPaused(true, 'founder', 'testing')
    expect((await getExecutionRolloutSettings()).emergencyPaused).toBe(true)
  })

  it('setDailySubmissionCap refuses a cap above the hard ceiling', async () => {
    // A safety control any caller can set to an arbitrary number is not a
    // safety control. The ceiling is now the founder operator's policy
    // maximum (150); raising it further must be a code+migration change.
    await expect(setDailySubmissionCap(151, 'founder')).rejects.toThrow(/may not exceed/i)
    await expect(setDailySubmissionCap(MAX_DAILY_SUBMISSION_CAP + 1, 'founder')).rejects.toThrow()
    await expect(setDailySubmissionCap(1500, 'founder')).rejects.toThrow(/may not exceed/i)
    // ...and the stored value is untouched by the rejected call.
    expect((await getExecutionRolloutSettings()).dailySubmissionCap).toBe(3)
  })

  it('setDailySubmissionCap accepts a cap at the ceiling', async () => {
    await setDailySubmissionCap(MAX_DAILY_SUBMISSION_CAP, 'founder')
    expect((await getExecutionRolloutSettings()).dailySubmissionCap).toBe(MAX_DAILY_SUBMISSION_CAP)
  })
})

describe('getRemainingDailySubmissionCapacity (#194)', () => {
  it('returns the full cap when nothing has been submitted today', async () => {
    expect(await getRemainingDailySubmissionCapacity()).toBe(3)
  })

  it('subtracts applications already SUBMITTED today', async () => {
    const todayIso = new Date().toISOString()
    fake.tables.job_search_applications.push({ id: 'a1', status: 'SUBMITTED', submitted_at: todayIso }, { id: 'a2', status: 'SUBMITTED', submitted_at: todayIso })
    expect(await getRemainingDailySubmissionCapacity()).toBe(1)
  })

  it('never goes negative', async () => {
    const todayIso = new Date().toISOString()
    for (let i = 0; i < 10; i++) fake.tables.job_search_applications.push({ id: `a${i}`, status: 'SUBMITTED', submitted_at: todayIso })
    expect(await getRemainingDailySubmissionCapacity()).toBe(0)
  })

  it('counts SUBMISSION_UNCERTAIN against the cap — it may have reached the employer', async () => {
    const todayIso = new Date().toISOString()
    fake.tables.job_search_applications.push(
      { id: 'a1', status: 'SUBMITTED', submitted_at: todayIso },
      { id: 'a2', status: 'SUBMISSION_UNCERTAIN', submitted_at: todayIso },
    )
    expect(await getRemainingDailySubmissionCapacity()).toBe(1)
  })

  it('ignores attempts from a previous day', async () => {
    fake.tables.job_search_applications.push({ id: 'old', status: 'SUBMITTED', submitted_at: '2020-01-01T00:00:00.000Z' })
    expect(await getRemainingDailySubmissionCapacity()).toBe(3)
  })
})

describe('rollout stage ladder', () => {
  it('advances 1 -> 5 -> 25 -> 75 -> 150 and then stops', () => {
    expect(nextRolloutStage(0)).toBe(1)
    expect(nextRolloutStage(1)).toBe(5)
    expect(nextRolloutStage(5)).toBe(25)
    expect(nextRolloutStage(25)).toBe(75)
    expect(nextRolloutStage(75)).toBe(150)
    expect(nextRolloutStage(150)).toBeNull()
  })

  it('never proposes a stage above the hard ceiling', () => {
    for (const stage of ROLLOUT_STAGES) expect(stage).toBeLessThanOrEqual(MAX_DAILY_SUBMISSION_CAP)
    expect(nextRolloutStage(MAX_DAILY_SUBMISSION_CAP)).toBeNull()
  })

  it('proposes the next rung up from an arbitrary intermediate cap, never a jump to the ceiling', () => {
    expect(nextRolloutStage(3)).toBe(5)
    expect(nextRolloutStage(30)).toBe(75)
  })
})
