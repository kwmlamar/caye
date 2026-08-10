import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  buildMatcher,
  ruleMatches,
  findMatchingRule,
  buildStandingRuleEscalation,
  buildStickyEscalation,
  type StandingRule,
} from './standing-rules'

const rule = (over: Partial<StandingRule> = {}): StandingRule => ({
  id: 'r1',
  trigger_type: 'service_mention',
  match_value: 'Full Bimini Experience',
  action: 'escalate',
  route_to: 'owner',
  ...over,
})

describe('buildMatcher', () => {
  it('matches case-insensitively', () => {
    expect(buildMatcher('Full Bimini Experience').test('the full bimini experience')).toBe(true)
  })

  it('requires word boundaries so short keywords do not over-match', () => {
    // Regression guard for brief §5.1: a rule on "VIP" firing on
    // "vipassana" is exactly the over-triggering that buries an owner.
    expect(buildMatcher('VIP').test('vipassana retreat')).toBe(false)
    expect(buildMatcher('VIP').test('we have a VIP arriving')).toBe(true)
  })

  it('treats regex metacharacters as literals', () => {
    // An owner naming a package with punctuation must not author a regex.
    expect(buildMatcher('Sunset (Private)').test('booking the Sunset (Private) trip')).toBe(true)
    expect(() => buildMatcher('a+b[c')).not.toThrow()
  })

  it('matches inside a longer phrase', () => {
    expect(buildMatcher('Eat Like a Local').test('is the Eat Like a Local tour available?')).toBe(true)
  })
})

describe('ruleMatches', () => {
  it('matches a structured intake-form submission', () => {
    const body = [
      'Name: Emily Sherman',
      'Guests: 3',
      'Tour: Full Bimini Experience',
      'Notes: golf cart tour please',
    ].join('\n')
    expect(ruleMatches(rule(), body)).toBe(true)
  })

  it('does not match a different tour', () => {
    expect(ruleMatches(rule(), 'Can I book the North Bimini Heritage tour?')).toBe(false)
  })
})

describe('findMatchingRule', () => {
  it('returns the first matching rule in list order', () => {
    const rules = [
      rule({ id: 'older', match_value: 'private charter', trigger_type: 'keyword' }),
      rule({ id: 'newer', match_value: 'Full Bimini Experience' }),
    ]
    const found = findMatchingRule(rules, 'we want a private charter on the Full Bimini Experience')
    expect(found?.id).toBe('older')
  })

  it('returns null when nothing matches', () => {
    expect(findMatchingRule([rule()], 'what time do you open?')).toBeNull()
  })

  it('returns null for an empty rule set', () => {
    expect(findMatchingRule([], 'Full Bimini Experience please')).toBeNull()
  })
})

describe('buildStandingRuleEscalation', () => {
  it('produces a ForcedEscalation routed per the rule', () => {
    const esc = buildStandingRuleEscalation(rule({ route_to: 'owner' }), 'Tour: Full Bimini Experience')
    expect(esc.trigger).toBe('standing_rule')
    expect(esc.routeTo).toBe('owner')
    expect(esc.category).toBe('policy')
  })

  it('keeps internal jargon out of the operator-facing ping', () => {
    // Same contract the hardcoded triggers are held to — pingSummary goes
    // to the owner's WhatsApp, internalContext is dashboard-only.
    const esc = buildStandingRuleEscalation(rule(), 'Tour: Full Bimini Experience')
    expect(esc.pingSummary).not.toMatch(/forced escalation/i)
    expect(esc.pingSummary).not.toMatch(/standing_rule/)
    expect(esc.pingSummary).toContain('Full Bimini Experience')
  })

  it('does not quote a price or commit to anything in the customer-facing message', () => {
    // The whole point of the rule: Caye must not price or hold.
    const esc = buildStandingRuleEscalation(rule(), 'Tour: Full Bimini Experience, 3 guests')
    expect(esc.customerFacingMessage).not.toMatch(/\$\d/)
    expect(esc.customerFacingMessage).not.toMatch(/hold|confirm|book/i)
  })

  it('honours a founder-routed rule', () => {
    const esc = buildStandingRuleEscalation(rule({ route_to: 'founder' }), 'Full Bimini Experience')
    expect(esc.routeTo).toBe('founder')
  })
})

describe('buildStickyEscalation', () => {
  // Delysia Weeks, 2026-08-09. The Full Bimini rule caught her first message.
  // Her follow-up — "What would solo be for the 4 hours (north and south)" —
  // names no service, so no rule matched it and the LLM answered alone,
  // quoting $199 as a flat solo total on a tour that needs three to run.
  const followUp = 'What would solo be for the 4 hours (north and south). Yes I am interested.'

  it('escalates a follow-up that names no service', () => {
    const esc = buildStickyEscalation(followUp)
    expect(esc.category).toBe('policy')
    expect(esc.routeTo).toBe('owner')
  })

  it('sends the same controlled template, never a drafted answer', () => {
    const esc = buildStickyEscalation(followUp)
    expect(esc.customerFacingMessage).toBe(
      buildStandingRuleEscalation(rule(), 'Full Bimini Experience').customerFacingMessage
    )
    expect(esc.customerFacingMessage).not.toMatch(/\$\d/)
  })

  it('keeps internal jargon out of the owner-facing ping', () => {
    const esc = buildStickyEscalation(followUp)
    expect(esc.pingSummary).not.toMatch(/forced escalation/i)
    expect(esc.pingSummary).not.toMatch(/standing_rule/)
    expect(esc.pingSummary).toContain('solo')
  })

  it('carries the customer words through to the operator brief', () => {
    const esc = buildStickyEscalation(followUp)
    expect(esc.internalContext).toContain('4 hours')
  })
})
