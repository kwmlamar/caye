import { describe, it, expect } from 'vitest'
import { conversationNeedsFounder, isAttentionHold, isQueueHold, holdKindOf, QUEUE_HOLD_KINDS } from './hold-kinds-shared'

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
})
