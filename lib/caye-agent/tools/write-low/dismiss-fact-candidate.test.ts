import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))

interface Candidate {
  id: string
  workspace_id: string
  status: string
}

let candidate: Candidate | null = null
let updatedCandidate: Record<string, unknown> | null = null

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'business_fact_candidates') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: candidate, error: null }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            updatedCandidate = patch
            return { error: null }
          },
        }),
      }
    },
  }),
}))

const { dismissFactCandidate } = await import('./dismiss-fact-candidate')

const ctx = { workspaceId: 'ws-1', callerRole: 'owner' } as unknown as ToolContext

beforeEach(() => {
  candidate = { id: 'cand-1', workspace_id: 'ws-1', status: 'proposed' }
  updatedCandidate = null
})

describe('dismiss_fact_candidate', () => {
  it('closes the row as dismissed with outcome ignored', async () => {
    const res = await dismissFactCandidate.execute({ candidate_id: 'cand-1' }, ctx)
    expect(res.ok).toBe(true)
    expect(updatedCandidate).toMatchObject({ status: 'dismissed', outcome: 'ignored' })
  })

  it('never touches business_facts', async () => {
    // If dismiss ever tried to insert a fact, the mock's from('business_facts')
    // branch would throw — the test passing at all is the assertion.
    await expect(dismissFactCandidate.execute({ candidate_id: 'cand-1' }, ctx)).resolves.toMatchObject({
      ok: true,
    })
  })

  it('refuses a candidate from a different workspace', async () => {
    candidate!.workspace_id = 'ws-other'
    const res = await dismissFactCandidate.execute({ candidate_id: 'cand-1' }, ctx)
    expect(res.ok).toBe(false)
    expect(updatedCandidate).toBeNull()
  })

  it('refuses a candidate that was already closed out', async () => {
    candidate!.status = 'dismissed'
    const res = await dismissFactCandidate.execute({ candidate_id: 'cand-1' }, ctx)
    expect(res.ok).toBe(false)
    expect(updatedCandidate).toBeNull()
  })

  it('errors cleanly when the candidate does not exist', async () => {
    candidate = null
    const res = await dismissFactCandidate.execute({ candidate_id: 'missing' }, ctx)
    expect(res.ok).toBe(false)
  })
})
