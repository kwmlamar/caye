import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { buildAllFixtures } from './index'
import { buildContinuityWillFixture } from './continuity-will'
import { buildNbcLaneyScopeFixture } from './nbc-laney-scope'
import { buildJulieSearchFixture } from './julie-search'
import { buildCorrectionNarrowingFixture } from './correction-narrowing'
import { buildSendRefinementFixture } from './send-refinement'
import { buildNoUnnecessaryActionFixture } from './no-unnecessary-action'
import { buildRealNbcLaneyFixture } from './real-nbc-laney'
import { buildRealContinuityWillFixture } from './real-continuity-will'
import { buildRealPamOttDraftChannelFixture } from './real-pam-ott-draft-channel'

/**
 * These tests check FIXTURE CONSTRUCTION — that each Case A–F fixture
 * assembles a coherent, well-formed `ReplayTurnInput` with the properties
 * the case is meant to probe (real multi-turn history, correct relative-
 * time markers, the right tools present, the scope-containment prompt
 * text actually included). They do not call the Anthropic API and do not
 * assert anything about what a live model would reply — that's a
 * deliberate boundary, not an oversight; see each fixture file's header
 * comment and the Phase 1 report for why live-model verification is a
 * separate, manual step in this phase.
 */

describe('replay fixtures — construction', () => {
  it('builds all six cases without throwing, each with a unique caseId', () => {
    const fixtures = buildAllFixtures()
    expect(fixtures).toHaveLength(6)
    const ids = fixtures.map((f) => f.meta.caseId)
    expect(new Set(ids).size).toBe(6)
  })

  it('Case A (continuity-will): real multi-turn history with relative-time markers, no tools', () => {
    const fixture = buildContinuityWillFixture()
    expect(fixture.mode).toBe('front-desk')
    // Multi-turn, not a single flattened string — the whole point of this case.
    expect(fixture.messages.length).toBeGreaterThan(1)
    const customerTurns = fixture.messages.filter(
      (m) => m.role === 'user' && typeof m.content === 'string'
    )
    for (const turn of customerTurns) {
      // Bracket-free relative-time marker — see lib/no-internal-leak-paths.test.ts.
      expect(turn.content as string).toMatch(/^\S.* — /)
      expect(turn.content as string).not.toMatch(/^\[/)
    }
    const lastTurn = fixture.messages[fixture.messages.length - 1]
    expect(lastTurn.content).toContain('just now')
    expect(lastTurn.content).toContain('Just paid and got my receipt!')
    expect(fixture.tools).toHaveLength(0)
    expect(fixture.systemPrompt).toContain('continuing it')
  })

  it('Case B (nbc-laney-scope): scope-containment instruction present, thread has unrelated open items', () => {
    const fixture = buildNbcLaneyScopeFixture()
    expect(fixture.mode).toBe('back-office')
    expect(fixture.systemPrompt).toContain('UNDERSTAND THE REQUEST BEFORE YOU ACT ON IT')
    expect(fixture.systemPrompt).toContain('is not permission to answer them too')
    const searchTool = fixture.tools.find((t) => t.name === 'search_threads')
    expect(searchTool).toBeDefined()
    expect(searchTool!.risk).toBe('read')
    const sendTool = fixture.tools.find((t) => t.name === 'send_reply')
    expect(sendTool!.risk).toBe('high')
    expect(fixture.messages[0].content).toContain('242-473-0233')
  })

  it('Case C (julie-search): ambiguity-resolution history present, get_customer available', () => {
    const fixture = buildJulieSearchFixture()
    expect(fixture.messages.some((m) => m.content === 'is there a Julie King')).toBe(true)
    expect(fixture.tools.map((t) => t.name)).toContain('get_customer')
    expect(fixture.systemPrompt).toContain('NEVER GUESS WHO THE OPERATOR IS REFERRING TO')
  })

  it('Case D (correction-narrowing): over-broad draft precedes the correction turn', () => {
    const fixture = buildCorrectionNarrowingFixture()
    const lastTurn = fixture.messages[fixture.messages.length - 1]
    expect(lastTurn.role).toBe('user')
    expect(lastTurn.content).toContain('no i just want them to know')
    expect(fixture.messages.some((m) => typeof m.content === 'string' && m.content.includes('gear for the shoot'))).toBe(true)
  })

  it('Case E (send-refinement): staged draft precedes a mechanical refinement instruction', () => {
    const fixture = buildSendRefinementFixture()
    const lastTurn = fixture.messages[fixture.messages.length - 1]
    expect(lastTurn.content).toBe('add safe travels to it')
    expect(fixture.tools.map((t) => t.name)).toEqual(['search_threads', 'send_reply'])
    const sendTool = fixture.tools.find((t) => t.name === 'send_reply')!
    // Regression cover: send_reply must expose a real schema (conversation_id
    // + body) — an earlier fixture draft used an empty schema, and Claude
    // correctly complied by never inventing those fields, silently defeating
    // this fixture's purpose. See helpers.ts's SEND_REPLY_SCHEMA doc comment.
    expect(Object.keys((sendTool.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['conversation_id', 'body'])
    )
  })

  it('Case F (no-unnecessary-action): read tools show nothing open', () => {
    const fixture = buildNoUnnecessaryActionFixture()
    const held = fixture.tools.find((t) => t.name === 'get_held_queue')
    expect(held).toBeDefined()
    expect(fixture.messages[0].content).toBe('anything going on?')
  })

  it('none of the fixtures declare a high-risk tool tagged as available outside back-office/front-desk (no scope creep in fixture roles)', () => {
    for (const fixture of buildAllFixtures()) {
      for (const tool of fixture.tools) {
        expect(tool.modes.every((m) => m === 'back-office' || m === 'front-desk')).toBe(true)
      }
    }
  })
})

/**
 * PHASE 1B (2026-08-16) — fixtures built from real, read-only, PII-scrubbed
 * production history rather than synthetic reconstructions. Not part of
 * buildAllFixtures() — see index.ts's doc comment for why.
 */
describe('replay fixtures — real-history construction (no PII, no DB access)', () => {
  it('real-nbc-laney: no surname/email/phone of the customer appears anywhere in the fixture', () => {
    const fixture = buildRealNbcLaneyFixture()
    const haystack = JSON.stringify(fixture)
    expect(haystack).not.toContain('Broussard')
    expect(haystack).not.toContain('nbcuni.com')
    expect(haystack).not.toContain('770-713-9274')
  })

  it('real-nbc-laney: carries the real send_reply schema, not the empty one', () => {
    const fixture = buildRealNbcLaneyFixture()
    const sendTool = fixture.tools.find((t) => t.name === 'send_reply')!
    expect(Object.keys((sendTool.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['conversation_id', 'body'])
    )
  })

  it('real-continuity-will: no surname/email/phone of the customer appears anywhere in the fixture', () => {
    const fixture = buildRealContinuityWillFixture()
    const haystack = JSON.stringify(fixture)
    expect(haystack).not.toContain('Miles')
    expect(haystack).not.toContain('gmail.com')
    expect(haystack).not.toContain('2259646774')
  })

  it('real-continuity-will: real multi-turn history with relative-time markers, mirrors the actual bug trigger', () => {
    const fixture = buildRealContinuityWillFixture()
    const lastTurn = fixture.messages[fixture.messages.length - 1]
    expect(lastTurn.content).toContain('Just laid it and got my receipt!')
    expect(fixture.messages.length).toBeGreaterThan(3)
  })

  it('real-pam-ott-draft-channel: verbatim "draft please" trigger, both send_reply and draft_in_inbox offered', () => {
    const fixture = buildRealPamOttDraftChannelFixture()
    const lastTurn = fixture.messages[fixture.messages.length - 1]
    expect(lastTurn.role).toBe('user')
    expect(lastTurn.content).toContain('draft please')
    expect(lastTurn.content).not.toMatch(/email|inbox|gmail/i)
    expect(fixture.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['send_reply', 'draft_in_inbox'])
    )
    // Both offered at HIGH risk post-fix — see registry.ts / high-risk-registry.ts.
    expect(fixture.tools.find((t) => t.name === 'draft_in_inbox')?.risk).toBe('high')
    expect(fixture.systemPrompt).toContain('COMPOSING A DRAFT VS. FILING AN EXTERNAL ONE')
  })

  it('real-pam-ott-draft-channel: no surname/email of the real customer appears anywhere in the fixture', () => {
    const fixture = buildRealPamOttDraftChannelFixture()
    const haystack = JSON.stringify(fixture)
    expect(haystack).not.toContain('Ott')
    expect(haystack).not.toContain('.com')
  })
})
