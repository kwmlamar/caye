import { describe, it, expect } from 'vitest'
import {
  resolveItemRefOutcome,
  describeUnresolved,
  formatChoices,
  namesUnresolvedTarget,
  type ResolvableItem,
} from './item-ref-resolution'

// Bimini's held queue at 18:27 on 2026-08-07, in order — the state Caye
// presented to Karenda right before the two failures this module fixes.
const PENDING: ResolvableItem[] = [
  { index: 1, contactName: 'ruslan@accessibletravelsolutions.com' },
  { index: 2, contactName: 'Jeff A Montenaro' },
]

const COPY = { nothingPending: "Nothing's on hold.", question: 'Which one did you handle?' }

describe('resolveItemRefOutcome', () => {
  it('distinguishes a named miss from a missing reference', () => {
    // The live failure: "Lisa is completed" → item_ref "Lisa Ramos", not held.
    expect(resolveItemRefOutcome(PENDING, 'Lisa Ramos')).toEqual({
      status: 'not-found',
      ref: 'Lisa Ramos',
    })
    // Distinct from giving no reference at all against a multi-item queue.
    expect(resolveItemRefOutcome(PENDING, undefined)).toEqual({ status: 'needs-choice' })
  })

  it('reports an empty queue before anything else', () => {
    expect(resolveItemRefOutcome([], 'Lisa Ramos')).toEqual({ status: 'no-pending' })
    expect(resolveItemRefOutcome([], undefined)).toEqual({ status: 'no-pending' })
  })

  it('matches a lone pending item with no reference', () => {
    const one = [PENDING[1]]
    expect(resolveItemRefOutcome(one, undefined)).toEqual({ status: 'matched', item: PENDING[1] })
  })

  it('matches by index, position word, and name substring', () => {
    expect(resolveItemRefOutcome(PENDING, '2')).toEqual({ status: 'matched', item: PENDING[1] })
    expect(resolveItemRefOutcome(PENDING, 'first')).toEqual({ status: 'matched', item: PENDING[0] })
    expect(resolveItemRefOutcome(PENDING, 'last')).toEqual({ status: 'matched', item: PENDING[1] })
    expect(resolveItemRefOutcome(PENDING, 'montenaro')).toEqual({
      status: 'matched',
      item: PENDING[1],
    })
  })

  it('treats an out-of-range index as a miss, not a silent ask', () => {
    expect(resolveItemRefOutcome(PENDING, '7')).toEqual({ status: 'not-found', ref: '7' })
  })

  it('matches a conversation id only when the caller supplies idOf', () => {
    const items = PENDING.map((p) => ({ ...p, conversationId: `conv-${p.index}` }))
    expect(resolveItemRefOutcome(items, 'conv-2', (i) => i.conversationId)).toEqual({
      status: 'matched',
      item: items[1],
    })
    expect(resolveItemRefOutcome(items, 'conv-2')).toEqual({ status: 'not-found', ref: 'conv-2' })
  })

  it('treats blank and whitespace refs as no reference', () => {
    expect(resolveItemRefOutcome(PENDING, '   ')).toEqual({ status: 'needs-choice' })
  })
})

describe('describeUnresolved', () => {
  it('names the missed item before re-listing the queue', () => {
    const reply = describeUnresolved({ status: 'not-found', ref: 'Lisa Ramos' }, PENDING, COPY)
    // The whole point: the operator must learn Lisa was never in the queue.
    expect(reply).toContain('Lisa Ramos')
    expect(reply).toContain('never have been escalated')
    expect(reply).toContain('Which one did you handle?')
    expect(reply).toContain('1. ruslan@accessibletravelsolutions.com')
  })

  it('asks plainly when no reference was given', () => {
    const reply = describeUnresolved({ status: 'needs-choice' }, PENDING, COPY)
    expect(reply).toBe(`Which one did you handle? ${formatChoices(PENDING)}`)
    expect(reply).not.toContain("I don't see")
  })

  it('reports an empty queue with the action-specific copy', () => {
    expect(describeUnresolved({ status: 'no-pending' }, [], COPY)).toBe("Nothing's on hold.")
  })
})

describe('namesUnresolvedTarget (CAY-90, Christopher/GGT incident)', () => {
  // GGT is currently held; Christopher — a customer discussed earlier in the
  // same conversation, but with nothing pending on his thread right now —
  // is not. This is exactly the Bimini queue shape from the incident.
  const QUEUE: ResolvableItem[] = [{ index: 1, contactName: 'GGT' }]

  it('is true when the operator names someone real but not currently held', () => {
    // The legacy path only knows the held queue — it cannot see that
    // Christopher was just discussed earlier in the agent's own memory, so
    // this must be flagged for hand-off rather than answered locally.
    expect(namesUnresolvedTarget(QUEUE, 'Christopher')).toBe(true)
  })

  it('is false when the name resolves against the held queue', () => {
    expect(namesUnresolvedTarget(QUEUE, 'GGT')).toBe(false)
  })

  it('is false when no reference was given at all — that is a genuine "which one?"', () => {
    // Distinct from a named miss: nobody, agent included, can resolve a
    // bare ref from nothing, so this stays a normal disambiguation ask.
    expect(namesUnresolvedTarget(QUEUE, undefined)).toBe(false)
    expect(namesUnresolvedTarget(QUEUE, '   ')).toBe(false)
  })

  it('is false against an empty queue — "nothing pending" is the honest answer either way', () => {
    expect(namesUnresolvedTarget([], 'Christopher')).toBe(false)
  })
})
