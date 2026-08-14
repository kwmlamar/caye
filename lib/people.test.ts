import { describe, it, expect } from 'vitest'
import {
  deriveProspect, deriveCustomer, describeProspectUnderstanding, describeCustomerUnderstanding,
  customerKnownFacts, prospectKnownFacts, type ProspectInput, type CustomerInput,
} from './people'

const NOW = new Date('2026-08-13T12:00:00Z')

function prospect(overrides: Partial<ProspectInput> = {}): ProspectInput {
  const input: ProspectInput = {
    stage: 'contacted',
    status: 'sent',
    opted_out_at: null,
    disqualified_reason: null,
    first_touch_sent_at: '2026-08-10T00:00:00Z',
    touches_sent: 1,
    last_touch_sent_at: null,
    tried_at: null,
    created_at: '2026-08-09T00:00:00Z',
    has_replied: false,
    has_unanswered_reply: false,
    awaiting_review: false,
    needsYou: false,
    ...overrides,
  }
  // Legacy fixture shorthand: a test saying "has replied" is asserting a
  // confirmed human reply, not merely a customer-shaped inbound row.
  if (overrides.has_replied && overrides.last_inbound_kind === undefined) {
    input.last_inbound_kind = 'human_reply'
  }
  return input
}

// Real production stage vocabulary: sourced/contacted/engaged/qualified/
// demo_started/activated/won/lost/disqualified — owned by
// lib/sales/funnel.ts, re-derived here via deriveStage(evidence) rather
// than trusted from a stored column. See this file's doc comment.
describe('deriveProspect', () => {
  it('an explicit disqualification outranks everything else', () => {
    const d = deriveProspect(prospect({ disqualified_reason: 'us_mainland', has_replied: true }), NOW)
    expect(d.state).toBe('disqualified')
    expect(d.nextAction).toBe('No further action')
  })

  it('opting out before ever replying is a disqualification in effect; after replying, a loss', () => {
    const beforeReply = deriveProspect(prospect({ opted_out_at: '2026-08-11T00:00:00Z' }), NOW)
    expect(beforeReply.state).toBe('disqualified')

    const afterReply = deriveProspect(prospect({ opted_out_at: '2026-08-11T00:00:00Z', has_replied: true }), NOW)
    expect(afterReply.state).toBe('lost')
    expect(afterReply.nextAction).toBe('No further action')
  })

  it('an unanswered reply means Caye is actively replying; once she has answered, she\'s just handling the thread', () => {
    // hasUnansweredReply outranks the send cadence in decideNextAction. Once
    // it's false again (Caye answered), engaged/qualified must NOT fall
    // through to the cadence math and recommend a scheduled "did you see
    // this" touch to someone she's already mid-conversation with — see the
    // stage_beyond_cadence fix in lib/sales/next-action.ts (found via this
    // exact test 2026-08-13: it originally failed, expecting 'Caye replying'
    // when the real decision was 'send_followup').
    const activelyReplying = deriveProspect(prospect({ has_replied: true, has_unanswered_reply: true, needsYou: false }), NOW)
    expect(activelyReplying.state).toBe('engaged')
    expect(activelyReplying.nextAction).toBe('Caye replying')

    const alreadyAnswered = deriveProspect(prospect({ has_replied: true, has_unanswered_reply: false, needsYou: false }), NOW)
    expect(alreadyAnswered.state).toBe('engaged')
    expect(alreadyAnswered.nextAction).toBe('Caye handling')
  })

  it('does not display an OOO/customer-shaped inbound as prospect engagement', () => {
    const d = deriveProspect(prospect({
      has_replied: true,
      has_unanswered_reply: true,
      last_inbound_kind: 'automated_ooo',
    }), NOW)
    expect(d.state).toBe('contacted')
    expect(d.nextAction).toBe('No further action')
  })

  it('does not report a bare legacy qualified label as qualification evidence', () => {
    expect(deriveProspect(prospect({ stage: 'qualified', qualified_at: null }), NOW).state).toBe('contacted')
    expect(deriveProspect(prospect({ stage: 'qualified', qualified_at: NOW.toISOString() }), NOW).state).toBe('qualified')
  })

  it('Needs You overrides the next action regardless of reply state', () => {
    const d = deriveProspect(prospect({ has_replied: true, needsYou: true }), NOW)
    expect(d.state).toBe('engaged')
    expect(d.nextAction).toBe('Waiting for you')
  })

  it('a reply outranks a cadence that would otherwise be exhausted — someone who eventually replied is not cold', () => {
    const d = deriveProspect(prospect({
      has_replied: true,
      first_touch_sent_at: '2026-07-01T00:00:00Z',
      touches_sent: 3,
      last_touch_sent_at: '2026-07-20T00:00:00Z',
    }), NOW)
    expect(d.state).toBe('engaged')
  })

  it('clicking the demo link renders "tried the demo" and Caye watches rather than chases', () => {
    const d = deriveProspect(prospect({ tried_at: '2026-08-12T00:00:00Z' }), NOW)
    expect(d.state).toBe('demo_started')
    expect(d.nextAction).toBe('Caye watching for a reply')
  })

  it('no first touch yet renders "Caye researching", not yet contacted', () => {
    const d = deriveProspect(prospect({ first_touch_sent_at: null, touches_sent: 0 }), NOW)
    expect(d.state).toBe('sourced')
    expect(d.nextAction).toBe('Caye will reach out soon')
  })

  it('a drafted outreach awaiting founder review says so in nextAction, without being a Needs You case', () => {
    const d = deriveProspect(prospect({ first_touch_sent_at: null, touches_sent: 0, awaiting_review: true }), NOW)
    expect(d.nextAction).toBe('Waiting for you to review and send')
    // Needs You itself is driven by the caller's needsYou input (queue
    // holds are deliberately excluded from that canonical predicate
    // elsewhere in the app) — deriveProspect doesn't invent a second one.
  })

  it('not yet due for a follow-up counts down using next-action.ts\'s real exported constants', () => {
    // first_touch_sent_at 3 days before NOW, touches_sent 1 (first touch
    // delivered) → anchor is first-touch, threshold is FOLLOWUP_1_DAYS (3d)
    // — exactly at the boundary, so decideNextAction says send_followup.
    const dueNow = deriveProspect(prospect({ first_touch_sent_at: '2026-08-10T12:00:00Z', touches_sent: 1 }), NOW)
    expect(dueNow.nextAction).toBe('Follow-up due')

    const notYetDue = deriveProspect(prospect({ first_touch_sent_at: '2026-08-12T12:00:00Z', touches_sent: 1 }), NOW)
    expect(notYetDue.state).toBe('contacted')
    expect(notYetDue.nextAction).toMatch(/^Follow up in ~\d+d$/)
  })

  it('past the follow-up cap and past the cold window is due for cold-marking', () => {
    const d = deriveProspect(prospect({
      first_touch_sent_at: '2026-07-01T00:00:00Z',
      touches_sent: 3,
      last_touch_sent_at: '2026-07-20T00:00:00Z',
    }), NOW)
    expect(d.nextAction).toBe('No further action')
    expect(d.state).toBe('lost')
  })

  it('touch count in the "current" sentence reflects touches_sent', () => {
    const first = deriveProspect(prospect({ touches_sent: 1 }), NOW)
    expect(first.current).toMatch(/first touch/)
    const second = deriveProspect(prospect({ touches_sent: 2, last_touch_sent_at: '2026-08-12T00:00:00Z' }), NOW)
    expect(second.current).toMatch(/touch 2/)
  })

  it('trusts the stored stage only for judgment calls it cannot verify itself (qualified/demo-completed/paying)', () => {
    // stage='qualified' with no other independent evidence — trusted,
    // since ICP qualification is a conversational judgment call this
    // module has no way to re-run.
    expect(deriveProspect(prospect({ stage: 'qualified', qualified_at: NOW.toISOString() }), NOW).state).toBe('qualified')
    expect(deriveProspect(prospect({ stage: 'activated' }), NOW).state).toBe('activated')
    expect(deriveProspect(prospect({ stage: 'won' }), NOW).state).toBe('won')
  })

  it('a stored stage outside the real enum falls back to sourced rather than crashing or guessing', () => {
    // outreach_leads.stage is NOT NULL DEFAULT 'sourced' with a real DB
    // CHECK constraint, so this shouldn't happen in practice — but this
    // module must stay boring and defensive about it regardless.
    const d = deriveProspect(prospect({ stage: 'not_a_real_stage', first_touch_sent_at: null, touches_sent: 0 }), NOW)
    expect(d.state).toBe('sourced')
  })

  it('being disqualified is never misread as "at or past won" — a rank-based evidence check would get this backwards', () => {
    // Regression guard for the bug found live 2026-08-13 (The Galley Bar &
    // Restaurant: stage='disqualified', disqualified_reason=null). Array
    // order in SALES_STAGES puts the terminal outcomes (won/lost/
    // disqualified) after the sequential ones, so comparing array indices
    // ("is stage's rank >= won's rank") reads 'disqualified' as further
    // along than 'won' — backwards, since a disqualified lead was never
    // paying. evidenceFrom uses exact equality per signal instead.
    const d = deriveProspect(prospect({ stage: 'disqualified', disqualified_reason: null }), NOW)
    expect(d.state).toBe('disqualified')
    expect(d.nextAction).toBe('No further action')
  })
})

function customer(overrides: Partial<CustomerInput> = {}): CustomerInput {
  return {
    is_blocked: false,
    opted_out: false,
    bookings: { count: 0, upcoming: null },
    needsYou: false,
    ...overrides,
  }
}

describe('deriveCustomer', () => {
  it('blocked and opted-out are terminal, checked before booking state', () => {
    expect(deriveCustomer(customer({ is_blocked: true, bookings: { count: 3, upcoming: null } })).state).toBe('blocked')
    expect(deriveCustomer(customer({ opted_out: true })).state).toBe('opted_out')
  })

  it('zero bookings renders New contact with no filler row context', () => {
    const d = deriveCustomer(customer())
    expect(d.state).toBe('new_contact')
    expect(d.rowContext).toBeNull()
    expect(d.nextAction).toBe('No further action')
  })

  it('exactly one booking renders Customer; more than one renders Returning customer', () => {
    expect(deriveCustomer(customer({ bookings: { count: 1, upcoming: null } })).state).toBe('customer')
    expect(deriveCustomer(customer({ bookings: { count: 3, upcoming: null } })).state).toBe('returning_customer')
  })

  it('an upcoming booking is named in the current-state sentence', () => {
    const d = deriveCustomer(customer({
      bookings: { count: 2, upcoming: { service_name: 'Sunset Cruise', booking_date: '2026-09-01' } },
    }))
    expect(d.current).toMatch(/Sunset Cruise/)
    expect(d.current).toMatch(/September 1/)
  })

  it('Needs You overrides the current-state sentence and next action regardless of booking history', () => {
    const d = deriveCustomer(customer({
      bookings: { count: 1, upcoming: { service_name: 'Tour', booking_date: '2026-09-01' } },
      needsYou: true,
    }))
    expect(d.nextAction).toBe('Waiting for you')
    expect(d.current).toMatch(/Waiting for you/)
  })

  it('rowContext is a plain booking count, omitted when there are none', () => {
    expect(deriveCustomer(customer({ bookings: { count: 1, upcoming: null } })).rowContext).toBe('1 booking')
    expect(deriveCustomer(customer({ bookings: { count: 3, upcoming: null } })).rowContext).toBe('3 bookings')
    expect(deriveCustomer(customer()).rowContext).toBeNull()
  })
})

describe('describeProspectUnderstanding', () => {
  it('never claims anything about what the business does or why they were sourced', () => {
    const text = describeProspectUnderstanding('Acme Charters', prospect(), NOW)
    // The real per-lead sourcing gap this file's doc comment documents —
    // regression guard against ever reintroducing a fabricated claim here.
    expect(text).not.toMatch(/operates|specializ|fishing|charter business|booking inquiries/i)
  })

  it('describes an unsent lead honestly, with no touch-count claim', () => {
    const text = describeProspectUnderstanding('Acme Charters', prospect({ status: 'sourced', first_touch_sent_at: null }), NOW)
    expect(text).toMatch(/sourced.*hasn't been contacted/)
  })

  it('mentions reply state and demo-tried state when real', () => {
    expect(describeProspectUnderstanding('Acme', prospect({ has_replied: true }), NOW)).toMatch(/replied/)
    expect(describeProspectUnderstanding('Acme', prospect({ status: 'tried', tried_at: '2026-08-12T00:00:00Z' }), NOW)).toMatch(/demo/)
  })
})

describe('describeCustomerUnderstanding', () => {
  it('states booking count and real facts only', () => {
    const text = describeCustomerUnderstanding(
      'Kelsey Tonner',
      customer({ bookings: { count: 3, upcoming: null } }),
      { group_composition: 'with family', preferences: ['private tours'] }
    )
    expect(text).toMatch(/booked 3 times/)
    expect(text).toMatch(/with family/)
    expect(text).toMatch(/private tours/)
  })

  it('is honest about zero bookings and omits fact sentences with no data', () => {
    const text = describeCustomerUnderstanding('New Guest', customer(), null)
    expect(text).toMatch(/hasn't booked yet/)
  })
})

describe('customerKnownFacts', () => {
  it('returns one line per real fact, nothing invented', () => {
    const lines = customerKnownFacts({ group_composition: 'with family', preferences: ['private tours'], dietary: ['vegetarian'] })
    expect(lines).toHaveLength(3)
    expect(lines.some((l) => l.includes('family'))).toBe(true)
  })

  it('returns an empty array — not a placeholder string — when there is nothing', () => {
    expect(customerKnownFacts(null)).toEqual([])
    expect(customerKnownFacts({})).toEqual([])
  })
})

describe('prospectKnownFacts', () => {
  it('renders relationship signals in founder-friendly phrasing', () => {
    const lines = prospectKnownFacts([
      { kind: 'objection', label: 'price_too_high', detail: null },
      { kind: 'question', label: 'whatsapp_integration', detail: 'Asked if it works with an existing number.' },
    ])
    expect(lines).toEqual([
      'Pushed back on price too high',
      'Asked about whatsapp integration — Asked if it works with an existing number.',
    ])
  })

  it('excludes outcome-kind signals — internal send telemetry, not relationship knowledge', () => {
    // Every real sales_lead_signals row of kind='outcome' seen live
    // (2026-08-13) is label='held_daily_cap_reached' — an internal
    // send-batching event, not anything about the person. Showing it under
    // "What Caye knows" would leak internal mechanics onto a founder-facing
    // surface, the same class of bug operator-text-guard.ts guards against
    // elsewhere.
    const lines = prospectKnownFacts([
      { kind: 'outcome', label: 'held_daily_cap_reached', detail: null },
      { kind: 'intent', label: 'asked_about_pricing_tiers', detail: null },
    ])
    expect(lines).toEqual(['Showed interest in asked about pricing tiers'])
  })
})
