import { describe, it, expect } from 'vitest'
import {
  conversationNeedsFounder,
  isAttentionHold,
  isQueueHold,
  isNonActionableHold,
  isFounderOnlyHold,
  holdKindOf,
  QUEUE_HOLD_KINDS,
  NON_ACTIONABLE_HOLD_KINDS,
  FOUNDER_ONLY_HOLD_KINDS,
} from './hold-kinds-shared'

// No `vi.mock('server-only', ...)` needed here — unlike hold-kinds.ts, this
// module has no server-only import, which is the entire point of the split
// (see its doc comment): client components need to import these predicates
// too.

describe('conversationNeedsFounder', () => {
  it('is false when the conversation is not held at all', () => {
    expect(conversationNeedsFounder({ human_agent_enabled: false, metadata: null })).toBe(false)
    expect(conversationNeedsFounder({ human_agent_enabled: false, metadata: { hold_kind: 'outreach_followup' } })).toBe(false)
  })

  it('is true for a real hold with no hold_kind (the conservative default)', () => {
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: null })).toBe(true)
    expect(conversationNeedsFounder({ human_agent_enabled: true })).toBe(true)
  })

  // The exact bug: San Juan PR Fishing Tours / Charters Puerto Rico / Out Of
  // The Blue Charters / FishNSea Charters in TropiTech Outreach all render
  // human_agent_enabled=true with hold_kind='outreach_followup' — Caye
  // drafted a cold-outreach follow-up and parked it for batch approval, not
  // an escalation. Before this predicate existed, ConversationRow's badge
  // read human_agent_enabled directly and showed "Needs you" for these,
  // while the Needs You tab (already correct) filtered them out via
  // isAttentionHold — a badge/filter mismatch. This test is the fix's
  // regression guard: one predicate, same answer everywhere.
  it('is false for drafted outreach parked for batch approval — matches the Needs You tab filter', () => {
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: { hold_kind: 'outreach_followup' } })).toBe(false)
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: { hold_kind: 'outreach_first_touch' } })).toBe(false)
  })

  it('is true for a real escalation hold_kind, and for an unrecognised future kind', () => {
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: { hold_kind: 'escalation' } })).toBe(true)
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: { hold_kind: 'some_future_kind' } })).toBe(true)
  })

  // 2026-08-26 owner-attention audit: Kelsey Tonner's newsletter blast
  // rendered simultaneously as "held automatically" (accurate) and "Needs
  // You — waiting for you" (a lie — nobody asked anything, there's no
  // decision). hold_kind='newsletter' is what fixes the second half without
  // touching the first: still held (visible, auditable, no auto-reply),
  // never an attention item.
  it('is false for a confidently-classified newsletter/blast hold, on every sighting (not just repeats)', () => {
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: { hold_kind: 'newsletter' } })).toBe(false)
  })

  // The Jonathan-shaped counterpart: a category='gap' escalation routed
  // solely to the founder ("the operator can't fix this") must not tell
  // THIS workspace's owner they have a call to make — they don't, the
  // founder does, and the founder is pinged through a separate channel.
  it('is false for a founder-only escalation gap — the owner has nothing to decide', () => {
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: { hold_kind: 'founder_gap' } })).toBe(false)
  })

  it('cold-sales triage stays a real attention item — genuinely ambiguous, not confidently noise', () => {
    expect(conversationNeedsFounder({ human_agent_enabled: true, metadata: { hold_kind: 'cold_sales_triage' } })).toBe(true)
  })
})

// Thin smoke coverage for the split itself — the full behavioral suite for
// these three lives in hold-kinds.test.ts (which re-imports them via
// hold-kinds.ts's re-export). This just confirms the shared module works
// standalone, with no server-only mock required.
describe('shared predicates (split from hold-kinds.ts)', () => {
  it('isQueueHold / isAttentionHold / holdKindOf work without a server-only mock', () => {
    expect(isQueueHold('outreach_followup')).toBe(true)
    expect(isAttentionHold('outreach_followup')).toBe(false)
    expect(holdKindOf({ hold_kind: 'outreach_followup' })).toBe('outreach_followup')
    expect([...QUEUE_HOLD_KINDS].sort()).toEqual(['outreach_first_touch', 'outreach_followup'])
  })

  it('isNonActionableHold / isFounderOnlyHold match their own sets and nothing else', () => {
    expect(isNonActionableHold('newsletter')).toBe(true)
    expect(isNonActionableHold('cold_sales_triage')).toBe(false)
    expect(isNonActionableHold('founder_gap')).toBe(false)
    expect(isNonActionableHold(null)).toBe(false)

    expect(isFounderOnlyHold('founder_gap')).toBe(true)
    expect(isFounderOnlyHold('newsletter')).toBe(false)
    expect(isFounderOnlyHold(undefined)).toBe(false)

    expect([...NON_ACTIONABLE_HOLD_KINDS]).toEqual(['newsletter'])
    expect([...FOUNDER_ONLY_HOLD_KINDS]).toEqual(['founder_gap'])
  })

  it('isAttentionHold excludes all three non-owner-attention categories, and only those', () => {
    expect(isAttentionHold('outreach_first_touch')).toBe(false) // queue
    expect(isAttentionHold('newsletter')).toBe(false) // non-actionable noise
    expect(isAttentionHold('founder_gap')).toBe(false) // founder-only
    expect(isAttentionHold('cold_sales_triage')).toBe(true) // genuinely ambiguous
    expect(isAttentionHold('escalation')).toBe(true) // real escalation
    expect(isAttentionHold(null)).toBe(true) // conservative default
  })
})
