import { describe, it, expect } from 'vitest'
import { decideNextAction, type LeadState } from './next-action'

const NOW = new Date('2026-08-12T12:00:00Z')

function lead(over: Partial<LeadState> = {}): LeadState {
  return {
    stage: 'contacted',
    firstTouchSentAt: '2026-08-09T12:00:00Z', // 3 days ago
    touchesSent: 1,
    lastTouchSentAt: null,
    optedOutAt: null,
    hasUnansweredReply: false,
    disqualifyingSignal: null,
    ...over,
  }
}

describe('decideNextAction', () => {
  it('sends a first touch to a sourced lead', () => {
    expect(
      decideNextAction(lead({ stage: 'sourced', firstTouchSentAt: null, touchesSent: 0 }), NOW).kind
    ).toBe('send_first_touch')
  })

  it('answers a waiting prospect ahead of any scheduled outbound', () => {
    // Someone asked a question 3 days after first touch. A follow-up is
    // technically due, but sending "did you see my email" to someone whose
    // question is sitting unanswered is the single worst thing here.
    const action = decideNextAction(lead({ hasUnansweredReply: true }), NOW)
    expect(action.kind).toBe('reply_to_prospect')
  })

  it('sends touch 2 at 3 days of silence, not before', () => {
    expect(decideNextAction(lead(), NOW)).toEqual({ kind: 'send_followup', touchNumber: 2 })
    const tooEarly = lead({ firstTouchSentAt: '2026-08-10T12:00:00Z' }) // 2 days
    expect(decideNextAction(tooEarly, NOW).kind).toBe('do_nothing')
  })

  it('sends touch 3 at 7 days after touch 2, not before', () => {
    const due = lead({ touchesSent: 2, lastTouchSentAt: '2026-08-05T12:00:00Z' }) // 7d
    expect(decideNextAction(due, NOW)).toEqual({ kind: 'send_followup', touchNumber: 3 })
    const early = lead({ touchesSent: 2, lastTouchSentAt: '2026-08-08T12:00:00Z' }) // 4d
    expect(decideNextAction(early, NOW).kind).toBe('do_nothing')
  })

  it('stops after three touches and marks cold at 14 days', () => {
    const spent = lead({ touchesSent: 3, lastTouchSentAt: '2026-08-11T12:00:00Z' })
    expect(decideNextAction(spent, NOW).kind).toBe('do_nothing')
    const cold = lead({ touchesSent: 3, lastTouchSentAt: '2026-07-29T12:00:00Z' }) // 14d
    expect(decideNextAction(cold, NOW).kind).toBe('mark_cold')
  })

  it('never contacts someone who opted out', () => {
    const out = lead({ optedOutAt: '2026-08-10T00:00:00Z', hasUnansweredReply: true })
    expect(decideNextAction(out, NOW).kind).toBe('do_nothing')
  })

  it('disqualifies on an ICP signal before doing anything else', () => {
    const bad = lead({ disqualifyingSignal: 'us_mainland' })
    expect(decideNextAction(bad, NOW)).toEqual({ kind: 'mark_disqualified', reason: 'us_mainland' })
  })

  it('leaves a prospect alone while they are mid-demo', () => {
    // The tracked click already proved they are alive; chasing them now
    // reads as pestering.
    expect(decideNextAction(lead({ stage: 'demo_started' }), NOW).kind).toBe('do_nothing')
    expect(decideNextAction(lead({ stage: 'activated' }), NOW).kind).toBe('do_nothing')
  })

  it('does nothing for terminal stages', () => {
    for (const stage of ['won', 'lost', 'disqualified'] as const) {
      expect(decideNextAction(lead({ stage }), NOW).kind).toBe('do_nothing')
    }
  })

  it('still answers an engaged prospect who wrote back', () => {
    const engaged = lead({ stage: 'engaged', hasUnansweredReply: true })
    expect(decideNextAction(engaged, NOW).kind).toBe('reply_to_prospect')
  })

  it('does not crash on unparseable timestamps', () => {
    expect(decideNextAction(lead({ firstTouchSentAt: 'not-a-date' }), NOW).kind).toBe('do_nothing')
  })
})
