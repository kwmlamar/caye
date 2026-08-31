import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/job-search/standing-authorization', () => ({
  getStandingAuthorization: async () => ({}),
  grantStandingAuthorization: async (input: { maxApplicationsPerDay?: number; minFitScore?: number }) => ({
    ok: true,
    policy: {
      maxApplicationsPerDay: input.maxApplicationsPerDay ?? 150,
      minFitScore: input.minFitScore ?? 70,
      allowedJobFamilies: [],
    },
  }),
  pauseStandingAuthorization: async () => {},
  resumeStandingAuthorization: async () => ({ ok: true }),
  revokeStandingAuthorization: async () => {},
  updateStandingPolicy: async () => ({ ok: true, policy: {} }),
  standingAuthorizationDenial: () => null,
}))
vi.mock('@/lib/job-search/execution/rollout', () => ({ getExecutionRolloutSettings: async () => ({ dailySubmissionCap: 1 }) }))

import {
  startJobApplications,
  pauseJobApplications,
  resumeJobApplications,
  stopJobApplications,
  setJobApplicationPolicy,
  getJobApplicationAutonomy,
} from './write-low/manage-job-application-autonomy'

const ALL = [
  startJobApplications,
  pauseJobApplications,
  resumeJobApplications,
  stopJobApplications,
  setJobApplicationPolicy,
  getJobApplicationAutonomy,
]

describe('founder isolation of standing job authority', () => {
  it.each(ALL.map((tool) => [tool.name, tool] as const))(
    '%s is founder-only — a customer or staff operator can never reach it',
    (_name, tool) => {
      expect(tool.roles).toEqual(['founder'])
      expect(tool.roles).not.toContain('owner')
      expect(tool.roles).not.toContain('staff')
      expect(tool.roles).not.toContain('customer')
    },
  )

  it.each(ALL.map((tool) => [tool.name, tool] as const))(
    '%s is never exposed on a customer-facing surface',
    (_name, tool) => {
      // front-desk is the guest-facing mode; these must not appear there.
      expect(tool.modes).not.toContain('front-desk')
      for (const mode of tool.modes) expect(['admin-shell', 'back-office']).toContain(mode)
    },
  )

  it('exposes no workspace argument, so policy cannot be scoped or spoofed per workspace', () => {
    for (const tool of ALL) {
      const properties = Object.keys(tool.inputSchema.properties ?? {})
      expect(properties).not.toContain('workspace_id')
      expect(properties).not.toContain('founder_user_id')
      expect(properties).not.toContain('actor')
    }
  })

  it('requires the founder instruction to start applications, and never an authorization flag', () => {
    const properties = startJobApplications.inputSchema.properties ?? {}
    expect(startJobApplications.inputSchema.required).toEqual(['instruction'])
    expect(Object.keys(properties)).not.toContain('authorized')
    expect(Object.keys(properties)).not.toContain('confirmed')
  })

  it('keeps stopping and pausing low-friction, and never behind a confirmation loop', () => {
    for (const tool of [pauseJobApplications, stopJobApplications]) {
      expect(tool.risk).toBe('low')
    }
  })
})

describe('starting autonomy reports the real operating ceiling', () => {
  it('surfaces the staged rollout cap when it is lower than the founder ceiling', async () => {
    const result = await startJobApplications.execute(
      { instruction: 'Start applying for jobs for me. Up to 150 a day.', max_applications_per_day: 150 },
      {} as never,
    )
    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    // The founder asked for 150 while the rollout cap is 1. Saying "150/day"
    // without that context would be a quietly false promise.
    expect(data.staged_rollout_cap).toBe(1)
    expect(data.effective_ceiling_today).toBe(1)
    expect(data.rollout_note).toContain('1/day')
  })

  it('tells the model not to ask for per-application confirmation afterwards', async () => {
    const result = await startJobApplications.execute({ instruction: 'Start applying for jobs for me.' }, {} as never)
    expect(String((result.data as Record<string, unknown>).note)).toMatch(/do NOT ask.*confirm/i)
  })
})
