import { describe, expect, it } from 'vitest'
import { classifySalesReplyIntent, requiresAutonomousSalesReply } from './reply-intent'

describe('Sales reply intent', () => {
  it.each([
    ['What are your advantages?', 'value_proposition_question', 'ANSWER_AND_PROPOSE_WORK'],
    ['Why should I use Caye?', 'value_proposition_question', 'ANSWER_AND_PROPOSE_WORK'],
    ['What can you actually do?', 'capability_question', 'ANSWER_AND_PROPOSE_WORK'],
    ['How does it work?', 'how_it_works', 'ANSWER_AND_PROPOSE_WORK'],
    ['How much does it cost?', 'pricing_question', 'ANSWER'],
    ["I'm interested.", 'interested', 'ADVANCE_TO_TRIAL_OR_WORK'],
    ['Can I try it with a demo?', 'demo_request', 'ADVANCE_TO_TRIAL_OR_WORK'],
    ['We already have staff.', 'objection', 'ANSWER_AND_PROPOSE_WORK'],
    ['We already use another system.', 'objection', 'ANSWER_AND_PROPOSE_WORK'],
    ["We don't get many messages.", 'objection', 'ANSWER_AND_PROPOSE_WORK'],
    ["AI isn't reliable.", 'objection', 'ANSWER_AND_PROPOSE_WORK'],
    ['Can you handle five customer inquiries?', 'explicit_work_request', 'ADVANCE_TO_TRIAL_OR_WORK'],
    ['Can you give me 70% off?', 'pricing_exception', 'ESCALATE'],
    ['Can you match competitor pricing?', 'pricing_exception', 'ESCALATE'],
    ['You have the wrong person.', 'wrong_contact', 'DISQUALIFY'],
    ['Could you refer me to the right owner?', 'referral', 'ASK_CLARIFICATION'],
    ['No thanks, not interested.', 'not_interested', 'DISQUALIFY'],
    ["Maybe.", 'ambiguity', 'ASK_CLARIFICATION'],
    ['Can I speak with Lamar?', 'human_requested', 'ESCALATE'],
    ['Can you guarantee 20 bookings?', 'unsupported_commitment', 'ESCALATE'],
  ] as const)('%s', (body, intent, nextAction) => {
    expect(classifySalesReplyIntent(body)).toEqual({ intent, nextAction })
  })

  it('does not confuse ordinary language with founder requests or authorization', () => {
    expect(classifySalesReplyIntent('We already have human staff.').intent).toBe('objection')
    expect(classifySalesReplyIntent('Can you tell me more about handling messages?').intent).not.toBe('explicit_work_request')
    expect(classifySalesReplyIntent('Maybe.').intent).toBe('ambiguity')
    expect(requiresAutonomousSalesReply('value_proposition_question')).toBe(true)
    expect(requiresAutonomousSalesReply('capability_question')).toBe(false)
  })
})
