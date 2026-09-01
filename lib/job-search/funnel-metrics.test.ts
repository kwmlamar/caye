import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => { throw new Error('not used by aggregateFunnelMetrics') } }))

import { aggregateFunnelMetrics, type ApplicationRow } from './funnel-metrics'

function row(overrides: Partial<ApplicationRow> & { id: string }): ApplicationRow {
  return {
    status: 'SUBMITTED',
    method: 'automated_ats',
    submitted_at: '2026-08-01T00:00:00.000Z',
    first_response_at: null,
    ghosted_at: null,
    candidate: { title: 'Software Engineer', discovered_via: [{ source_key: 'greenhouse' }] },
    ...overrides,
  }
}

describe('aggregateFunnelMetrics', () => {
  it('excludes autoresponder-only applications from the response rate', () => {
    // No first_response_at set — email-correlation.ts never sets it for a
    // confirmation_check-only application — so this must not count as a response.
    const rows = [row({ id: 'a1' })]
    const metrics = aggregateFunnelMetrics(rows, new Map([['a1', new Set(['confirmation_check'])]]))
    expect(metrics.applications).toBe(1)
    expect(metrics.responses).toBe(0)
    expect(metrics.responseRate).toBe(0)
  })

  it('computes response rate, positive-response rate, and interview conversion over applications', () => {
    const rows = [
      row({ id: 'a1', status: 'REJECTED', first_response_at: '2026-08-05T00:00:00.000Z' }),
      row({ id: 'a2', status: 'INTERVIEW', first_response_at: '2026-08-03T00:00:00.000Z' }),
      row({ id: 'a3' }), // silence, no response at all
      row({ id: 'a4' }), // silence, no response at all
    ]
    const types = new Map([
      ['a1', new Set(['rejection'])],
      ['a2', new Set(['interview_request'])],
    ])
    const metrics = aggregateFunnelMetrics(rows, types)
    expect(metrics.applications).toBe(4)
    expect(metrics.responses).toBe(2)
    expect(metrics.responseRate).toBe(0.5)
    expect(metrics.positiveResponses).toBe(1) // only the interview_request one is positive
    expect(metrics.positiveResponseRate).toBe(0.25)
    expect(metrics.interviews).toBe(1)
    expect(metrics.interviewConversionRate).toBe(0.25)
    expect(metrics.rejections).toBe(1)
  })

  it('computes median response time in hours from submitted_at to first_response_at', () => {
    const rows = [
      row({ id: 'a1', submitted_at: '2026-08-01T00:00:00.000Z', first_response_at: '2026-08-02T00:00:00.000Z' }), // 24h
      row({ id: 'a2', submitted_at: '2026-08-01T00:00:00.000Z', first_response_at: '2026-08-04T00:00:00.000Z' }), // 72h
      row({ id: 'a3', submitted_at: '2026-08-01T00:00:00.000Z', first_response_at: '2026-08-11T00:00:00.000Z' }), // 240h
    ]
    const metrics = aggregateFunnelMetrics(rows, new Map([
      ['a1', new Set(['recruiter_interest'])],
      ['a2', new Set(['recruiter_interest'])],
      ['a3', new Set(['recruiter_interest'])],
    ]))
    expect(metrics.medianResponseHours).toBe(72)
  })

  it('breaks down applications and response rate by job title', () => {
    const rows = [
      row({ id: 'a1', candidate: { title: 'Backend Engineer', discovered_via: [] }, first_response_at: '2026-08-02T00:00:00.000Z' }),
      row({ id: 'a2', candidate: { title: 'Backend Engineer', discovered_via: [] } }),
      row({ id: 'a3', candidate: { title: 'Frontend Engineer', discovered_via: [] }, first_response_at: '2026-08-02T00:00:00.000Z' }),
    ]
    const metrics = aggregateFunnelMetrics(rows, new Map([['a1', new Set(['recruiter_interest'])], ['a3', new Set(['recruiter_interest'])]]))
    const backend = metrics.byTitle.find((r) => r.key === 'Backend Engineer')
    const frontend = metrics.byTitle.find((r) => r.key === 'Frontend Engineer')
    expect(backend).toMatchObject({ applications: 2, responses: 1, responseRate: 0.5 })
    expect(frontend).toMatchObject({ applications: 1, responses: 1, responseRate: 1 })
  })

  it('breaks down applications by source and by application strategy (method)', () => {
    const rows = [
      row({ id: 'a1', method: 'automated_ats', candidate: { title: 'X', discovered_via: [{ source_key: 'greenhouse' }] } }),
      row({ id: 'a2', method: 'manual', candidate: { title: 'X', discovered_via: [{ source_key: 'lever' }] } }),
    ]
    const metrics = aggregateFunnelMetrics(rows, new Map())
    expect(metrics.bySource.map((r) => r.key).sort()).toEqual(['greenhouse', 'lever'])
    expect(metrics.byStrategy.map((r) => r.key).sort()).toEqual(['automated_ats', 'manual'])
  })
})
