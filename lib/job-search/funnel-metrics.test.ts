import { describe, expect, it } from 'vitest'
import { calculateJobResponseFunnel } from './funnel-metrics'

describe('calculateJobResponseFunnel', () => {
  it('counts application-level outcomes without double-counting replies', () => {
    const applications = [
      { id: 'a1', submitted_at: '2026-08-01T12:00:00.000Z', first_response_at: '2026-08-02T12:00:00.000Z' },
      { id: 'a2', submitted_at: '2026-08-01T12:00:00.000Z', first_response_at: '2026-08-03T12:00:00.000Z' },
      { id: 'a3', submitted_at: '2026-08-01T12:00:00.000Z', first_response_at: null },
    ]
    const followups = [
      { application_id: 'a1', direction: 'INBOUND', response_classification: 'recruiter_interest' as const },
      { application_id: 'a1', direction: 'INBOUND', response_classification: 'screen_request' as const },
      { application_id: 'a2', direction: 'INBOUND', response_classification: 'rejection' as const },
      { application_id: 'a3', direction: 'OUTBOUND', response_classification: 'interview_request' as const },
    ]

    expect(calculateJobResponseFunnel(applications, followups)).toEqual({
      applications: 3,
      responses: 2,
      positiveResponses: 1,
      screens: 1,
      interviews: 0,
      offers: 0,
      rejections: 1,
      averageResponseLatencyHours: 36,
    })
  })
})
