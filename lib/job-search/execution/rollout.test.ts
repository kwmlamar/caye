import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './test-support/fake-supabase'

vi.mock('server-only', () => ({}))

let fake = makeFakeSupabase()
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => fake.client }))
vi.mock('../events', () => ({ logJobSearchEvent: vi.fn(async () => {}) }))

const { getExecutionRolloutSettings, setAutomationEnabled, setDryRun, setDailySubmissionCap, setEmergencyPaused, getRemainingDailySubmissionCapacity } = await import('./rollout')

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
})
