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
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              candidateUpdates.push(patch)
              return { error: null }
            },
          }),
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
