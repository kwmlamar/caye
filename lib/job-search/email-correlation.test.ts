import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./events', () => ({ logJobSearchEvent: async () => {} }))

type Row = Record<string, unknown>

const state: { followupDup: Row | null; applications: Row[]; inserted: Row[]; updates: Row[] } = {
  followupDup: null,
  applications: [],
  inserted: [],
  updates: [],
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'job_search_followups') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.followupDup, error: null }),
            }),
          }),
          insert: async (row: Row) => {
            state.inserted.push(row)
            return { error: null }
          },
        }
      }
      if (table === 'job_search_applications') {
        return {
          select: () => ({
            in: () => ({
              order: () => ({
                limit: async () => ({ data: state.applications, error: null }),
              }),
            }),
          }),
          update: (patch: Row) => ({
            eq: async () => {
              state.updates.push(patch)
              const target = state.applications[0]
              if (target) Object.assign(target, patch)
              return { error: null }
            },
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { correlateRecruiterEmail } from './email-correlation'

function seedApplication(overrides: Row = {}) {
  state.applications = [{
    id: 'app_1',
    status: 'SUBMITTED',
    submitted_at: '2026-08-01T00:00:00.000Z',
    first_response_at: null,
    candidate: { company: 'Acme Corp', title: 'Backend Engineer', requisition_id: 'REQ-1' },
    ...overrides,
  }]
}

beforeEach(() => {
  state.followupDup = null
  state.inserted = []
  state.updates = []
  seedApplication()
})

describe('correlateRecruiterEmail — response classification wiring', () => {
  it('sets status to REJECTED (not FOLLOWUP_DUE) on a rejection email — the bug this loop fixes', async () => {
    const result = await correlateRecruiterEmail({
      provider: 'zoho',
      messageId: 'msg_1',
      emailFrom: 'recruiting@acmecorp.com',
      emailSubject: 'Update on your Backend Engineer application at Acme Corp',
      emailSnippet: 'Unfortunately, we have decided to move forward with other candidates for this role.',
    })
    expect(result).toMatchObject({ status: 'correlated', followupType: 'rejection' })
    expect(state.updates[0]).toMatchObject({ status: 'REJECTED' })
    expect(state.updates[0].rejected_at).toBeTruthy()
  })

  it('bumps priority to high on recruiter interest, without changing status away from what it already needs', async () => {
    const result = await correlateRecruiterEmail({
      provider: 'zoho',
      messageId: 'msg_2',
      emailFrom: 'jane@acmecorp.com',
      emailSubject: 'Your background at Acme Corp',
      emailSnippet: 'I came across your profile and think you could be a great fit for our team — would love to connect.',
    })
    expect(result).toMatchObject({ status: 'correlated', followupType: 'recruiter_interest' })
    expect(state.updates[0]).toMatchObject({ status: 'FOLLOWUP_DUE', priority: 'high' })
  })

  it('does not change status or set first_response_at for a pure autoresponder ack', async () => {
    const result = await correlateRecruiterEmail({
      provider: 'zoho',
      messageId: 'msg_3',
      emailFrom: 'noreply@acmecorp.com',
      emailSubject: 'Thanks for applying to Acme Corp',
      emailSnippet: 'We have received your application for the Backend Engineer role.',
    })
    expect(result).toMatchObject({ status: 'correlated', followupType: 'confirmation_check' })
    expect(state.updates).toHaveLength(0)
  })

  it('sets first_response_at only on the first genuine response, and updates last_response_at on subsequent ones', async () => {
    seedApplication({ first_response_at: '2026-08-02T00:00:00.000Z' })
    const result = await correlateRecruiterEmail({
      provider: 'zoho',
      messageId: 'msg_4',
      emailFrom: 'jane@acmecorp.com',
      emailSubject: 'Quick call about Backend Engineer at Acme Corp',
      emailSnippet: 'Could you please send an updated resume?',
    })
    expect(result).toMatchObject({ status: 'correlated', followupType: 'additional_information' })
    expect(state.updates[0].first_response_at).toBeUndefined()
    expect(state.updates[0].last_response_at).toBeTruthy()
  })

  it('does not correlate when two applications tie on match score — never assume ambiguous mail belongs to a job', async () => {
    state.applications = [
      { id: 'app_1', status: 'SUBMITTED', submitted_at: '2026-08-01T00:00:00.000Z', first_response_at: null, candidate: { company: 'Acme Corp', title: 'Backend Engineer', requisition_id: null } },
      { id: 'app_2', status: 'SUBMITTED', submitted_at: '2026-08-01T00:00:00.000Z', first_response_at: null, candidate: { company: 'Acme Corp', title: 'Frontend Engineer', requisition_id: null } },
    ]
    const result = await correlateRecruiterEmail({
      provider: 'zoho',
      messageId: 'msg_5',
      emailFrom: 'recruiting@acmecorp.com',
      emailSubject: 'Update from Acme Corp',
      emailSnippet: 'Thanks for your interest.',
    })
    expect(result).toEqual({ status: 'no_match' })
    expect(state.inserted).toHaveLength(0)
  })
})
