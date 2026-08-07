import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/llm-telemetry', () => ({ loggedMessagesCreate: vi.fn() }))

const { findSemanticFactMatch } = await import('./business-fact-semantic-match')

// These two guard paths return before ever constructing an Anthropic client, so
// they exercise real behavior with no LLM mocking required — and they're the
// paths that matter most for cost: every skipped LLM call on an empty or
// clearly-unrelated candidate set is a call that never gets billed.
describe('findSemanticFactMatch — guard paths (no LLM call)', () => {
  it('returns no match immediately when there is nothing to compare against', async () => {
    const result = await findSemanticFactMatch('The dock closes at 5pm.', [], {
      workspaceId: 'ws-1',
      source: 'test',
    })
    expect(result).toEqual({ matchId: null })
  })

  it('returns no match when nothing shares a meaningful word', async () => {
    // 2026-08-07 finding: TropiTech Outreach's cold-outreach copy ("coordinating
    // limo pickups and tours") false-positived into the OLD keyword detector by
    // matching "pickup" as a substring. The word-overlap pre-filter here uses
    // whole normalized words, so unrelated sentences that happen to share no
    // real vocabulary should never even reach the model.
    const result = await findSemanticFactMatch(
      'Refunds are processed within thirty days.',
      [{ id: 'cand-1', text: 'The tram stop is the meeting point for cruise guests.' }],
      { workspaceId: 'ws-1', source: 'test' }
    )
    expect(result).toEqual({ matchId: null })
  })
})
