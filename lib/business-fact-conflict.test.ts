import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate: vi.fn() }))

const { findConflictingFact, outranksForSupersession, factSourceRank } = await import('./business-fact-conflict')

// These guard paths return before ever constructing an Anthropic client —
// same rationale as business-fact-semantic-match.test.ts's guard-path tests:
// every skipped LLM call on an empty or clearly-unrelated fact list is a
// call that never gets billed, and the common case (a brand-new, unrelated
// fact) should never hit the model at all.
describe('findConflictingFact — guard paths (no LLM call)', () => {
  it('returns no conflict immediately when there is nothing to compare against', async () => {
    const result = await findConflictingFact('The dock closes at 5pm.', [], {
      workspaceId: 'ws-1',
      source: 'test',
    })
    expect(result).toEqual({ conflictId: null, resolution: null })
  })

  it('returns no conflict when nothing shares a meaningful word', async () => {
    const result = await findConflictingFact(
      'Refunds are processed within thirty days.',
      [{ id: 'fact-1', text: 'The tram stop is the meeting point for cruise guests.', source: 'owner-direct' }],
      { workspaceId: 'ws-1', source: 'test' }
    )
    expect(result).toEqual({ conflictId: null, resolution: null })
  })
})

describe('factSourceRank / outranksForSupersession', () => {
  it('ranks owner-direct and escalation-capture above candidate-confirmed', () => {
    expect(factSourceRank('owner-direct')).toBeGreaterThan(factSourceRank('candidate-confirmed'))
    expect(factSourceRank('escalation-capture')).toBeGreaterThan(factSourceRank('candidate-confirmed'))
  })

  it('lets owner-direct supersede any prior source', () => {
    expect(outranksForSupersession('owner-direct', 'owner-direct')).toBe(true)
    expect(outranksForSupersession('owner-direct', 'escalation-capture')).toBe(true)
    expect(outranksForSupersession('owner-direct', 'candidate-confirmed')).toBe(true)
  })

  it('refuses to let an inferred candidate-confirmed fact supersede an owner-direct one', () => {
    expect(outranksForSupersession('candidate-confirmed', 'owner-direct')).toBe(false)
  })

  it('lets candidate-confirmed supersede another candidate-confirmed fact', () => {
    expect(outranksForSupersession('candidate-confirmed', 'candidate-confirmed')).toBe(true)
  })

  it('treats an unknown source as rank zero rather than throwing', () => {
    expect(factSourceRank('made-up-source')).toBe(0)
    expect(outranksForSupersession('owner-direct', 'made-up-source')).toBe(true)
    expect(outranksForSupersession('made-up-source', 'owner-direct')).toBe(false)
  })
})
