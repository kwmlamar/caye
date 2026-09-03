import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// vi.hoisted: vi.mock() factories below are hoisted to the top of the
// module, above any plain `const x = vi.fn()`. Declaring these via
// vi.hoisted() ensures they exist before the (also-hoisted) mock factories
// that close over them run, avoiding "Cannot access before initialization".
const mocks = vi.hoisted(() => {
  let queryResults: Array<{ data: unknown; error: null | { message: string } }> = []

  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    ilike: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    maybeSingle: vi.fn(),
    then: vi.fn(),
  }

  for (const method of ['select', 'eq', 'ilike', 'order', 'limit'] as const) {
    builder[method].mockImplementation(() => builder)
  }
  builder.maybeSingle.mockImplementation(async () => queryResults.shift() ?? { data: null, error: null })
  builder.then.mockImplementation((resolve: (value: unknown) => unknown) => Promise.resolve(queryResults.shift() ?? { data: null, error: null }).then(resolve))

  const from = vi.fn(() => builder)

  return {
    runJobSearchInspection: vi.fn(),
    inspectApplicationForHumanAssist: vi.fn(),
    recordAnswer: vi.fn(),
    builder,
    from,
    getQueryResults: () => queryResults,
    setQueryResults: (next: typeof queryResults) => {
      queryResults = next
    },
  }
})

const { runJobSearchInspection, inspectApplicationForHumanAssist, recordAnswer, from } = mocks

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({ from: mocks.from }) }))
vi.mock('@/app/api/caye/job-search-inspect/route', () => ({
  runJobSearchInspection: mocks.runJobSearchInspection,
  inspectApplicationForHumanAssist: mocks.inspectApplicationForHumanAssist,
}))
vi.mock('../write-low/record-job-search-answer', () => ({
  recordJobSearchAnswer: { execute: mocks.recordAnswer },
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
    from.mockClear()
    mocks.setQueryResults([])
  })

  it('is a direct founder read-style tool, not a submission action', () => {
    expect(inspectJobSearchApplications.name).toBe('inspect_job_search_applications')
    expect(inspectJobSearchApplications.risk).toBe('read')
    expect(inspectJobSearchApplications.roles).toEqual(['founder'])
    expect(inspectJobSearchApplications.modes).toContain('back-office')
    expect(inspectJobSearchApplications.description).toContain('company')
    expect(inspectJobSearchApplications.description).toContain('Never invent an application UUID')
    expect(inspectJobSearchApplications.description).toContain('never submits')
  })

  it('runs queue inspection immediately with no arguments', async () => {
    runJobSearchInspection.mockResolvedValue({ inspected: 5, results: [{ outcome: 'needs_human' }] })
    const result = await inspectJobSearchApplications.execute({}, ctx)
    expect(runJobSearchInspection).toHaveBeenCalledTimes(1)
    expect(from).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, data: { inspected: 5, results: [{ outcome: 'needs_human' }] } })
  })

  it('inspects one exact PREPARED application when application_id is valid', async () => {
    mocks.setQueryResults([{ data: { id: 'app-1' }, error: null }])
    inspectApplicationForHumanAssist.mockResolvedValue({ applicationId: 'app-1', applicationStatus: 'PREPARED', finalAnswers: [] })
    const result = await inspectJobSearchApplications.execute({ application_id: 'app-1' }, ctx)
    expect(result.ok).toBe(true)
    expect(inspectApplicationForHumanAssist).toHaveBeenCalledWith('app-1')
    expect(recordAnswer).not.toHaveBeenCalled()
  })

  it('recovers when a candidate id was mistakenly supplied as application_id', async () => {
    mocks.setQueryResults([
      { data: null, error: null },
      { data: [{ id: 'app-1' }], error: null },
    ])
    inspectApplicationForHumanAssist.mockResolvedValue({ applicationId: 'app-1', applicationStatus: 'PREPARED', finalAnswers: [] })
    const result = await inspectJobSearchApplications.execute({ application_id: 'candidate-1' }, ctx)
    expect(result.ok).toBe(true)
    expect(inspectApplicationForHumanAssist).toHaveBeenCalledWith('app-1')
  })

  it('resolves a natural company selector to its single PREPARED application', async () => {
    mocks.setQueryResults([{
      data: [{
        id: 'app-scaleops',
        status: 'PREPARED',
        updated_at: '2026-08-31T00:00:00Z',
        candidate: { company: 'scaleops', title: 'Technical Support Engineer' },
      }],
      error: null,
    }])
    inspectApplicationForHumanAssist.mockResolvedValue({ applicationId: 'app-scaleops', applicationStatus: 'PREPARED', finalAnswers: [] })
    const result = await inspectJobSearchApplications.execute({ company: 'ScaleOps', title: 'Technical Support Engineer' }, ctx)
    expect(result.ok).toBe(true)
    expect(inspectApplicationForHumanAssist).toHaveBeenCalledWith('app-scaleops')
  })

  it('preserves explicit founder answer persistence after resolving the selector', async () => {
    mocks.setQueryResults([{ data: { id: 'app-1' }, error: null }])
    recordAnswer.mockResolvedValue({ ok: true, data: { applicationId: 'app-1' } })
    const result = await inspectJobSearchApplications.execute({
      application_id: 'app-1',
      question: 'Are you authorized?',
      answer: 'Yes',
    }, ctx)
    expect(result.ok).toBe(true)
    expect(recordAnswer).toHaveBeenCalledWith({
      application_id: 'app-1',
      question: 'Are you authorized?',
      answer: 'Yes',
    }, ctx)
    expect(inspectApplicationForHumanAssist).not.toHaveBeenCalled()
  })

  it('fails closed for a partial answer write before touching the database', async () => {
    const result = await inspectJobSearchApplications.execute({ application_id: 'app-1', question: 'Question' }, ctx)
    expect(result.ok).toBe(false)
    expect(from).not.toHaveBeenCalled()
    expect(inspectApplicationForHumanAssist).not.toHaveBeenCalled()
    expect(recordAnswer).not.toHaveBeenCalled()
  })
})
