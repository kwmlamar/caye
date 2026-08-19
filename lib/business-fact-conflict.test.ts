import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const loggedMessagesCreate = vi.fn()
vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate }))

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

// CAY-14 reliability fix: a judge/infra failure must never be treated the
// same as "no conflict" once there's a plausible candidate to check against
// — that's exactly how the original incident happened (an old fact stayed
// active because nothing flagged the contradiction). These tests only
// reach the LLM call because the fact shares a word with an active fact,
// so the guard path above does not short-circuit them.
describe('findConflictingFact — judge/infra failure fails closed', () => {
  it('fails closed (checkFailed) when the model call throws, instead of reporting no conflict', async () => {
    loggedMessagesCreate.mockRejectedValueOnce(new Error('network error'))

    const result = await findConflictingFact(
      'Cash is fine with Max.',
      [{ id: 'fact-old-payment', text: 'Cash is not accepted.', source: 'owner-direct' }],
      { workspaceId: 'ws-1', source: 'test' }
    )

    expect(result).toEqual({ conflictId: null, resolution: null, checkFailed: true })
  })

  it('fails closed (checkFailed) when the model returns unparseable JSON', async () => {
    loggedMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json' }],
    })

    const result = await findConflictingFact(
      'Cash is fine with Max.',
      [{ id: 'fact-old-payment', text: 'Cash is not accepted.', source: 'owner-direct' }],
      { workspaceId: 'ws-1', source: 'test' }
    )

    expect(result).toEqual({ conflictId: null, resolution: null, checkFailed: true })
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
