import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * Double-capture regression: the Operator Learning Router and the passive
 * business-fact-suggestions detector are two independent producers into the
 * SAME business_facts table. This proves the existing wiring — this file
 * had no test coverage before this PR — actually suppresses a duplicate
 * proposal once the router has already saved the fact, rather than that
 * being an assumption in the architecture audit.
 */

interface CandidateRow {
  id: string
  status: 'pending' | 'proposed' | 'resolved' | 'dismissed'
  occurrence_count: number
  conversation_ids: unknown
  sample_text: string
}

let existingCandidate: CandidateRow | null = null
let candidateUpdates: Record<string, unknown>[] = []
let operatorMessagesInserted: Record<string, unknown>[] = []
let candidateInserts: Record<string, unknown>[] = []

vi.mock('@/lib/business-facts', () => ({
  // Simulates the router having already written this fact — a fresh read,
  // same fetchBusinessFacts() the Front Desk / back-office prompt uses.
  fetchBusinessFacts: async () => [
    { id: 'fact-router-1', category: 'logistics', fact: 'Cruise guests should take the complimentary tram to the Casino Tram Stop.' },
  ],
}))

let semanticMatchId: string | null = 'fact-router-1'
vi.mock('@/lib/business-fact-semantic-match', () => ({
  findSemanticFactMatch: async () => ({ matchId: semanticMatchId }),
}))

vi.mock('@/lib/whatsapp/triggers', () => ({
  operatorPingsEnabled: async () => false,
}))
vi.mock('@/lib/whatsapp/outbound', () => ({
  sendFreeFormWhatsApp: async () => {
    throw new Error('should never be called when the candidate resolves instead of proposing')
  },
  deliveryFieldsFromResult: () => ({}),
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table === 'business_fact_candidates') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: existingCandidate, error: null }),
              }),
              // Open-candidate semantic-merge lookup (only reached when no
              // exact-normalized-text match was found above).
              in: async () => ({ data: [], error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              candidateUpdates.push(patch)
              return { error: null }
            },
          }),
          insert: (row: Record<string, unknown>) => {
            candidateInserts.push(row)
            return { error: null }
          },
        }
      }
      if (table === 'caye_operator_messages') {
        return {
          insert: (row: Record<string, unknown>) => {
            operatorMessagesInserted.push(row)
            return { select: () => ({ single: async () => ({ data: { id: 'msg-1' }, error: null }) }) }
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

const { maybeSuggestBusinessFacts } = await import('./business-fact-suggestions')

beforeEach(() => {
  existingCandidate = null
  candidateUpdates = []
  operatorMessagesInserted = []
  candidateInserts = []
  semanticMatchId = 'fact-router-1'
})

describe('maybeSuggestBusinessFacts — double-capture avoidance', () => {
  it('resolves the candidate instead of proposing a duplicate once the router has already saved the same fact', async () => {
    // Crossing OCCURRENCE_THRESHOLD (3): an existing pending candidate at
    // occurrence_count=2, this call is the 3rd distinct conversation.
    existingCandidate = {
      id: 'candidate-1',
      status: 'pending',
      occurrence_count: 2,
      conversation_ids: ['c1', 'c2'],
      sample_text: 'Please take the complimentary tram to the Casino Tram Stop.',
    }

    await maybeSuggestBusinessFacts(
      'ws-1',
      'c3',
      'Please take the complimentary tram to the Casino Tram Stop for pickup.'
    )

    // Marked resolved, not proposed — overlapsExistingFact found the
    // router-authored fact via a fresh fetchBusinessFacts read.
    expect(candidateUpdates.some((u) => u.status === 'resolved')).toBe(true)
    expect(candidateUpdates.some((u) => u.status === 'proposed')).toBe(false)
    // No duplicate proposal ever written into the operator's sliding window.
    expect(operatorMessagesInserted).toHaveLength(0)
  })

  // Real production case (2026-08-26 historical-learning audit, Bimini
  // Island Tours): business_fact_candidates row 683ad270-... ("It is free,
  // it runs continuously and the Casino stop is one of the stops...") sat
  // at occurrence_count=2, status='pending' — BELOW OCCURRENCE_THRESHOLD (3)
  // — even three minutes AFTER the authoritative fact ("The pickup location
  // for all tours is the Casino Tram Stop...") was saved via a different
  // path. The old code only ever checked overlapsExistingFact once a
  // candidate crossed the propose threshold, so a stale below-threshold
  // candidate was never cleaned up. This proves the fix: the check now runs
  // on every re-occurrence, not just at the threshold.
  it('resolves a stale BELOW-THRESHOLD candidate the moment it is re-touched, without waiting for occurrence_count to reach the propose threshold (real Casino Tram Stop case)', async () => {
    existingCandidate = {
      id: 'candidate-683ad270',
      status: 'pending',
      occurrence_count: 1, // well below OCCURRENCE_THRESHOLD (3)
      conversation_ids: ['c1'],
      sample_text: 'You are welcome to take the free tram directly to the Casino Tram Stop.',
    }

    await maybeSuggestBusinessFacts(
      'ws-1',
      'c2',
      'It is free, it runs continuously, and the Casino stop is one of the stops — nothing to figure out.'
    )

    expect(candidateUpdates.some((u) => u.status === 'resolved')).toBe(true)
    // Never reached the propose step at all — no ping, no sliding-window insert.
    expect(operatorMessagesInserted).toHaveLength(0)
  })

  // Same fix, the other entry point: a sentence that would otherwise start
  // a BRAND NEW candidate is never even inserted when it already matches
  // active knowledge — not just cleaned up after the fact.
  it('never creates a new candidate for a first-time sentence that already matches an active fact', async () => {
    existingCandidate = null // no candidate row exists yet at all
    await maybeSuggestBusinessFacts(
      'ws-1',
      'c1',
      'Guests can take the free tram directly to the Casino Tram Stop for pickup.'
    )
    expect(candidateInserts).toHaveLength(0)
  })

  it('still proposes normally when nothing matches an existing fact (the router has NOT captured this topic)', async () => {
    semanticMatchId = null
    existingCandidate = {
      id: 'candidate-2',
      status: 'pending',
      occurrence_count: 2,
      conversation_ids: ['c1', 'c2'],
      sample_text: 'Parking is at the north lot near the pier.',
    }

    await maybeSuggestBusinessFacts('ws-1', 'c3', 'Parking is at the north lot near the pier, close to the dock.')

    expect(candidateUpdates.some((u) => u.status === 'proposed')).toBe(true)
    expect(operatorMessagesInserted).toHaveLength(1)
    expect(operatorMessagesInserted[0]).toMatchObject({ intent: 'fact_suggestion' })
  })
})
