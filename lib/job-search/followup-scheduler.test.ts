import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./events', () => ({ logJobSearchEvent: async () => {} }))

type Row = Record<string, unknown>

const state: { applications: Row[]; followupsByApp: Record<string, Row[]>; inserted: Row[]; updates: { id: string; patch: Row }[] } = {
  applications: [],
  followupsByApp: {},
  inserted: [],
  updates: [],
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'job_search_applications') {
        return {
          select: () => ({
            in: () => ({
              is: () => ({
                not: () => ({ limit: async () => ({ data: state.applications, error: null }) }),
              }),
            }),
          }),
          update: (patch: Row) => ({
            eq: async (_col: string, id: string) => {
              state.updates.push({ id, patch })
              const app = state.applications.find((a) => a.id === id)
              if (app) Object.assign(app, patch)
              return { error: null }
            },
          }),
        }
      }
      if (table === 'job_search_followups') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              order: async () => ({ data: state.followupsByApp[id] ?? [], error: null }),
            }),
          }),
          insert: async (row: Row) => {
            state.inserted.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { runFollowupSweep } from './followup-scheduler'

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

beforeEach(() => {
  state.applications = []
  state.followupsByApp = {}
  state.inserted = []
  state.updates = []
})

describe('runFollowupSweep', () => {
  it('does nothing for an application submitted only 3 days ago', async () => {
    state.applications = [{ id: 'a1', status: 'SUBMITTED', submitted_at: daysAgo(3), last_response_at: null, ghosted_at: null }]
    state.followupsByApp.a1 = []
    const result = await runFollowupSweep()
    expect(result).toEqual({ flagged: 0, ghosted: 0, skipped: 1 })
    expect(state.inserted).toHaveLength(0)
  })

  it('flags a first check-in after 10+ days of silence', async () => {
    state.applications = [{ id: 'a1', status: 'SUBMITTED', submitted_at: daysAgo(12), last_response_at: null, ghosted_at: null }]
    state.followupsByApp.a1 = []
    const result = await runFollowupSweep()
    expect(result.flagged).toBe(1)
    expect(state.inserted[0]).toMatchObject({ application_id: 'a1', followup_type: 'scheduled_followup', direction: 'outbound' })
    expect(state.updates[0]).toMatchObject({ id: 'a1', patch: { status: 'FOLLOWUP_DUE' } })
  })

  it('does not stack a second check-in marker while one is already unsent — the anti-annoyance cap', async () => {
    state.applications = [{ id: 'a1', status: 'FOLLOWUP_DUE', submitted_at: daysAgo(20), last_response_at: null, ghosted_at: null }]
    state.followupsByApp.a1 = [{ followup_type: 'scheduled_followup', direction: 'outbound', sent_at: null, created_at: daysAgo(12) }]
    const result = await runFollowupSweep()
    expect(result).toEqual({ flagged: 0, ghosted: 0, skipped: 1 })
    expect(state.inserted).toHaveLength(0)
  })

  it('flags a second check-in only after the gap since the first (sent) nudge', async () => {
    state.applications = [{ id: 'a1', status: 'FOLLOWUP_DUE', submitted_at: daysAgo(25), last_response_at: daysAgo(8), ghosted_at: null }]
    state.followupsByApp.a1 = [{ followup_type: 'scheduled_followup', direction: 'outbound', sent_at: daysAgo(17), created_at: daysAgo(17) }]
    const result = await runFollowupSweep()
    expect(result.flagged).toBe(1)
  })

  it('never flags a third check-in — caps at 2 automated nudges', async () => {
    state.applications = [{ id: 'a1', status: 'FOLLOWUP_DUE', submitted_at: daysAgo(60), last_response_at: daysAgo(40), ghosted_at: null }]
    state.followupsByApp.a1 = [
      { followup_type: 'scheduled_followup', direction: 'outbound', sent_at: daysAgo(50), created_at: daysAgo(50) },
      { followup_type: 'scheduled_followup', direction: 'outbound', sent_at: daysAgo(40), created_at: daysAgo(40) },
    ]
    const result = await runFollowupSweep()
    expect(result.flagged).toBe(0)
  })

  it('marks an application ghosted once follow-ups are exhausted and enough silence has passed', async () => {
    state.applications = [{ id: 'a1', status: 'FOLLOWUP_DUE', submitted_at: daysAgo(90), last_response_at: daysAgo(50), ghosted_at: null }]
    state.followupsByApp.a1 = [
      { followup_type: 'scheduled_followup', direction: 'outbound', sent_at: daysAgo(80), created_at: daysAgo(80) },
      { followup_type: 'scheduled_followup', direction: 'outbound', sent_at: daysAgo(60), created_at: daysAgo(60) },
    ]
    const result = await runFollowupSweep()
    expect(result.ghosted).toBe(1)
    expect(state.updates.some((u) => u.id === 'a1' && u.patch.ghosted_at)).toBe(true)
  })

  it('skips an application with an unresolved routine-category inbound message — that needs a direct reply, not a generic nudge', async () => {
    state.applications = [{ id: 'a1', status: 'FOLLOWUP_DUE', submitted_at: daysAgo(20), last_response_at: daysAgo(15), ghosted_at: null }]
    state.followupsByApp.a1 = [{ followup_type: 'screen_request', direction: 'inbound', sent_at: null, created_at: daysAgo(15) }]
    const result = await runFollowupSweep()
    expect(result).toEqual({ flagged: 0, ghosted: 0, skipped: 1 })
  })
})
