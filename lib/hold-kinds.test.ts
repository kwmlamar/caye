import { describe, it, expect } from 'vitest'
import { isQueueHold, isAttentionHold, holdKindOf, QUEUE_HOLD_KINDS } from './hold-kinds'

describe('isQueueHold', () => {
  it('recognises both batchable outreach kinds', () => {
    expect(isQueueHold('outreach_first_touch')).toBe(true)
    expect(isQueueHold('outreach_followup')).toBe(true)
  })

  it('does not treat an ordinary hold as a queue item', () => {
    expect(isQueueHold(null)).toBe(false)
    expect(isQueueHold(undefined)).toBe(false)
    expect(isQueueHold('escalation')).toBe(false)
    expect(isQueueHold('')).toBe(false)
  })

  it('ignores non-string values', () => {
    expect(isQueueHold(42)).toBe(false)
    expect(isQueueHold({ hold_kind: 'outreach_followup' })).toBe(false)
  })
})

describe('isAttentionHold', () => {
  // The two real Bimini holds (a complaint from 2026-07-24 and a policy
  // call from 07-25) carry no hold_kind at all.
  it('counts a hold with no kind as needing attention', () => {
    expect(isAttentionHold(null)).toBe(true)
  })

  it('excludes drafted outreach awaiting batch approval', () => {
    expect(isAttentionHold('outreach_followup')).toBe(false)
    expect(isAttentionHold('outreach_first_touch')).toBe(false)
  })

  // Deliberately conservative: a hold path that forgets to set hold_kind
  // must surface to the operator, not vanish into a queue nobody checks.
  it('defaults an unrecognised kind to needing attention', () => {
    expect(isAttentionHold('some_future_kind')).toBe(true)
  })
})

describe('holdKindOf', () => {
  it('reads hold_kind out of a metadata blob', () => {
    expect(holdKindOf({ hold_kind: 'outreach_followup' })).toBe('outreach_followup')
  })

  it('returns null for missing or malformed metadata', () => {
    expect(holdKindOf(null)).toBeNull()
    expect(holdKindOf(undefined)).toBeNull()
    expect(holdKindOf({})).toBeNull()
    expect(holdKindOf('not an object')).toBeNull()
    expect(holdKindOf({ hold_kind: 7 })).toBeNull()
  })

  it('composes with the predicates the readers actually use', () => {
    const outreachThread = { hold_kind: 'outreach_followup', proposed_reply: 'Hey,' }
    const complaintThread = { escalated: true }
    expect(isAttentionHold(holdKindOf(outreachThread))).toBe(false)
    expect(isAttentionHold(holdKindOf(complaintThread))).toBe(true)
  })
})

describe('QUEUE_HOLD_KINDS', () => {
  // send_outreach_batch gates on this exact set. If the read layer and the
  // send gate disagree, a thread can be hidden from the operator but still
  // batch-sendable, or shown but unsendable.
  it('is exactly the two batchable outreach kinds', () => {
    expect([...QUEUE_HOLD_KINDS].sort()).toEqual(['outreach_first_touch', 'outreach_followup'])
  })
})
