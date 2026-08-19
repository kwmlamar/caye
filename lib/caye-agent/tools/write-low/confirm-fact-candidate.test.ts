import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/whatsapp/schedule', () => ({
  loadScheduleConfig: async () => ({ timezone: 'America/New_York' }),
  localDateISO: () => '2026-08-01',
  endOfLocalDayUTC: () => new Date('2026-09-01T03:59:59Z'),
}))

interface Candidate {
  id: string
  workspace_id: string
  sample_text: string
  category_guess: string
  status: string
}

interface ExistingFact {
  id: string
  fact: string
  source: string
  expires_at: string | null
}

let candidate: Candidate | null = null
let activeFacts: ExistingFact[] = []
let insertedFact: Record<string, unknown> | null = null
let updatedCandidate: Record<string, unknown> | null = null
let supersededFact: Record<string, unknown> | null = null

// findConflictingFact itself is unit tested (business-fact-conflict.test.ts)
// against the real LLM-judge shape — mocked here so this file's tests control
// the resolution directly instead of steering an LLM prompt into a verdict.
let conflictResult: {
  conflictId: string | null
  resolution: 'supersede' | 'ambiguous' | null
  checkFailed?: boolean
} = {
  conflictId: null,
  resolution: null,
}
vi.mock('@/lib/business-fact-conflict', async () => {
  const actual = await vi.importActual<typeof import('@/lib/business-fact-conflict')>(
    '@/lib/business-fact-conflict'
  )
  return {
    ...actual,
    findConflictingFact: async () => conflictResult,
  }
})

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'business_fact_candidates') {
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
      }
      if (table === 'business_facts') {
        return {
          select: () => ({
            eq: () => ({
              is: async () => ({ data: activeFacts, error: null }),
            }),
          }),
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                insertedFact = row
                return { data: { id: 'fact-1', created_at: '2026-08-07T00:00:00Z' }, error: null }
              },
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              supersededFact = patch
              return { error: null }
            },
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

const { confirmFactCandidate } = await import('./confirm-fact-candidate')

const ctx = { workspaceId: 'ws-1', callerRole: 'owner' } as unknown as ToolContext

beforeEach(() => {
  candidate = {
    id: 'cand-1',
    workspace_id: 'ws-1',
    sample_text: 'Meeting Point: Resorts World Bimini Casino Tram Stop',
    category_guess: 'logistics',
    status: 'proposed',
  }
  activeFacts = []
  conflictResult = { conflictId: null, resolution: null }
  insertedFact = null
  updatedCandidate = null
  supersededFact = null
})

describe('confirm_fact_candidate', () => {
  it('saves the fact with source candidate-confirmed', async () => {
    const res = await confirmFactCandidate.execute(
      { candidate_id: 'cand-1', fact: 'Meeting Point: Resorts World Bimini Casino Tram Stop' },
      ctx
    )
    expect(res.ok).toBe(true)
    expect(insertedFact).toMatchObject({
      workspace_id: 'ws-1',
      source: 'candidate-confirmed',
      category: 'logistics',
    })
  })

  // The whole point of this tool: distinguish "accepted as-is" from "accepted
  // but changed" so decision 7's correction-rate signal means something.
  it('marks outcome confirmed when the saved text matches the proposal', async () => {
    const res = await confirmFactCandidate.execute(
      { candidate_id: 'cand-1', fact: 'Meeting Point: Resorts World Bimini Casino Tram Stop' },
      ctx
    )
    expect((res.data as { outcome: string }).outcome).toBe('confirmed')
    expect(updatedCandidate).toMatchObject({ status: 'resolved', outcome: 'confirmed' })
  })

  it('ignores whitespace reflow when judging confirmed vs corrected', async () => {
    const res = await confirmFactCandidate.execute(
      { candidate_id: 'cand-1', fact: '  Meeting Point:   Resorts World Bimini Casino Tram Stop  ' },
      ctx
    )
    expect((res.data as { outcome: string }).outcome).toBe('confirmed')
  })

  it('marks outcome corrected when the operator changed the wording', async () => {
    const res = await confirmFactCandidate.execute(
      {
        candidate_id: 'cand-1',
        fact: 'The meeting point is the pink building by the dock, not the tram stop.',
      },
      ctx
    )
    expect((res.data as { outcome: string }).outcome).toBe('corrected')
    expect(updatedCandidate).toMatchObject({ outcome: 'corrected' })
  })

  it('links the candidate row to the fact it produced', async () => {
    await confirmFactCandidate.execute(
      { candidate_id: 'cand-1', fact: 'Meeting Point: Resorts World Bimini Casino Tram Stop' },
      ctx
    )
    expect(updatedCandidate).toMatchObject({ resolved_fact_id: 'fact-1' })
  })

  it('refuses a candidate from a different workspace', async () => {
    candidate!.workspace_id = 'ws-other'
    const res = await confirmFactCandidate.execute(
      { candidate_id: 'cand-1', fact: 'Anything.' },
      ctx
    )
    expect(res.ok).toBe(false)
    expect(insertedFact).toBeNull()
  })

  it('refuses a candidate that was already closed out', async () => {
    candidate!.status = 'resolved'
    const res = await confirmFactCandidate.execute(
      { candidate_id: 'cand-1', fact: 'Anything.' },
      ctx
    )
    expect(res.ok).toBe(false)
    expect(insertedFact).toBeNull()
  })

  it('rejects a too-short fact before touching the database', async () => {
    const res = await confirmFactCandidate.execute({ candidate_id: 'cand-1', fact: 'Hi' }, ctx)
    expect(res.ok).toBe(false)
    expect(insertedFact).toBeNull()
  })

  // CAY-14: an inferred (Caye-proposed, owner-approved) fact must never
  // silently outrank an explicit owner-direct fact, even when the LLM judge
  // says "supersede" — rule 3 (owner-direct corrections outrank inferred
  // knowledge) is enforced here regardless of what the judge concludes.
  describe('CAY-14 supersession', () => {
    it('refuses to supersede an owner-direct fact even when the judge says supersede', async () => {
      activeFacts = [{ id: 'fact-old', fact: 'Cash is not accepted.', source: 'owner-direct', expires_at: null }]
      conflictResult = { conflictId: 'fact-old', resolution: 'supersede' }

      const res = await confirmFactCandidate.execute(
        { candidate_id: 'cand-1', fact: 'Cash is accepted.' },
        ctx
      )
      expect(res.ok).toBe(false)
      expect(insertedFact).toBeNull()
      expect(supersededFact).toBeNull()
    })

    it('supersedes a lower-ranked candidate-confirmed fact when the judge says supersede', async () => {
      activeFacts = [
        { id: 'fact-old', fact: 'Parking is free at the north lot.', source: 'candidate-confirmed', expires_at: null },
      ]
      conflictResult = { conflictId: 'fact-old', resolution: 'supersede' }

      const res = await confirmFactCandidate.execute(
        { candidate_id: 'cand-1', fact: 'Parking now costs $10/day at the north lot.' },
        ctx
      )
      expect(res.ok).toBe(true)
      expect(insertedFact).toMatchObject({ source: 'candidate-confirmed' })
      expect(supersededFact).toMatchObject({ superseded_by: 'fact-1' })
    })

    it('fails closed on an ambiguous conflict without saving or superseding anything', async () => {
      activeFacts = [
        { id: 'fact-old', fact: 'Tours run daily at 9am.', source: 'candidate-confirmed', expires_at: null },
      ]
      conflictResult = { conflictId: 'fact-old', resolution: 'ambiguous' }

      const res = await confirmFactCandidate.execute(
        { candidate_id: 'cand-1', fact: 'The heritage tour now starts at 10am.' },
        ctx
      )
      expect(res.ok).toBe(false)
      expect(insertedFact).toBeNull()
      expect(supersededFact).toBeNull()
    })

    // CAY-14 reliability fix: a conflict check that couldn't run at all
    // (judge/infra failure) must never be treated as "no conflict" — that's
    // exactly how the original incident happened.
    it('fails closed when the conflict check itself failed, without saving or superseding anything', async () => {
      activeFacts = [
        { id: 'fact-old', fact: 'Cash is not accepted.', source: 'candidate-confirmed', expires_at: null },
      ]
      conflictResult = { conflictId: null, resolution: null, checkFailed: true }

      const res = await confirmFactCandidate.execute(
        { candidate_id: 'cand-1', fact: 'Cash is accepted.' },
        ctx
      )
      expect(res.ok).toBe(false)
      expect(insertedFact).toBeNull()
      expect(supersededFact).toBeNull()
    })
  })
})
