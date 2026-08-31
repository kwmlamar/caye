import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const runJobSearchInspection = vi.fn()
const inspectApplicationForHumanAssist = vi.fn()
const recordAnswer = vi.fn()

vi.mock('@/app/api/caye/job-search-inspect/route', () => ({
  runJobSearchInspection,
  inspectApplicationForHumanAssist,
}))
vi.mock('../write-low/record-job-search-answer', () => ({
  recordJobSearchAnswer: { execute: recordAnswer },
}))

import { inspectJobSearchApplications } from './inspect-job-search-applications'

const ctx = {
  workspaceId: '00000000-0000-0000-0000-000000000000',
  callerRole: 'founder' as const,
  operatorId: null,
  requestId: 'req-inspect',
}

describe('inspectJobSearchApplications', () => {
  beforeEach(() => {
    runJobSearchInspection.mockReset()
    inspectApplicationForHumanAssist.mockReset()
    recordAnswer.mockReset()
  })

  it('is a direct founder read-style tool, not a submission action', () => {
    expect(inspectJobSearchApplications.name).toBe('inspect_job_search_applications')
    expect(inspectJobSearchApplications.risk).toBe('read')
    expect(inspectJobSearchApplications.roles).toEqual(['founder'])
    expect(inspectJobSearchApplications.modes).toContain('back-office')
    expect(inspectJobSearchApplications.description).toContain('application_id only')
    expect(inspectJobSearchApplications.description).toContain('never submits')
  })

  it('runs queue inspection immediately with no arguments', async () => {
    runJobSearchInspection.mockResolvedValue({ inspected: 5, results: [{ outcome: 'needs_human' }] })
    const result = await inspectJobSearchApplications.execute({}, ctx)
    expect(runJobSearchInspection).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, data: { inspected: 5, results: [{ outcome: 'needs_human' }] } })
  })

  it('inspects one exact PREPARED application when application_id is supplied alone', async () => {
    inspectApplicationForHumanAssist.mockResolvedValue({ applicationId: 'app-1', applicationStatus: 'PREPARED', finalAnswers: [] })
    const result = await inspectJobSearchApplications.execute({ application_id: 'app-1' }, ctx)
    expect(result.ok).toBe(true)
    expect(inspectApplicationForHumanAssist).toHaveBeenCalledWith('app-1')
    expect(runJobSearchInspection).not.toHaveBeenCalled()
    expect(recordAnswer).not.toHaveBeenCalled()
  })

  it('preserves explicit founder answer persistence when all three fields are supplied', async () => {
    recordAnswer.mockResolvedValue({ ok: true, data: { applicationId: 'app-1' } })
    const result = await inspectJobSearchApplications.execute({
      application_id: 'app-1',
      question: 'Are you authorized?',
      answer: 'Yes',
    }, ctx)
    expect(result.ok).toBe(true)
    expect(recordAnswer).toHaveBeenCalledTimes(1)
    expect(inspectApplicationForHumanAssist).not.toHaveBeenCalled()
  })

  it('fails closed for a partial answer write', async () => {
    const result = await inspectJobSearchApplications.execute({ application_id: 'app-1', question: 'Question' }, ctx)
    expect(result.ok).toBe(false)
    expect(inspectApplicationForHumanAssist).not.toHaveBeenCalled()
    expect(recordAnswer).not.toHaveBeenCalled()
  })
})
