import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const runJobSearchInspection = vi.fn()
vi.mock('@/app/api/caye/job-search-inspect/route', () => ({ runJobSearchInspection }))

import { inspectJobSearchApplications } from './inspect-job-search-applications'

describe('inspectJobSearchApplications', () => {
  beforeEach(() => runJobSearchInspection.mockReset())

  it('is a direct founder read-style tool, not a confirmation-gated cron', () => {
    expect(inspectJobSearchApplications.name).toBe('inspect_job_search_applications')
    expect(inspectJobSearchApplications.risk).toBe('read')
    expect(inspectJobSearchApplications.roles).toEqual(['founder'])
    expect(inspectJobSearchApplications.modes).toContain('back-office')
    expect(inspectJobSearchApplications.description).toContain('Do not ask for confirmation')
    expect(inspectJobSearchApplications.description).toContain('cannot submit applications')
  })

  it('runs inspection immediately and returns its real result', async () => {
    runJobSearchInspection.mockResolvedValue({ inspected: 5, results: [{ outcome: 'needs_human' }] })
    const result = await inspectJobSearchApplications.execute({}, {
      workspaceId: '00000000-0000-0000-0000-000000000000',
      callerRole: 'founder',
      operatorId: null,
      requestId: 'req-inspect',
    })
    expect(runJobSearchInspection).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, data: { inspected: 5, results: [{ outcome: 'needs_human' }] } })
  })
})
