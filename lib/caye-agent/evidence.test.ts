import { describe, it, expect, vi } from 'vitest'
import {
  decideDisposition,
  evaluateAction,
  ownerNoteFor,
  ownerReasonLabelFor,
  partialAvailabilityNoteFor,
  type EvidenceFact,
  type DispositionResult,
} from './evidence'

vi.mock('server-only', () => ({}))

const set = (...facts: EvidenceFact[]) => new Set<EvidenceFact>(facts)

describe('action policy', () => {
  it('never gates a plain informational reply', () => {
    // "What time do you open?" must not need a booking's worth of evidence.
    expect(evaluateAction('informational_reply', set()).permitted).toBe(true)
  })

  it('requires the availability rules to have actually been evaluated', () => {
    const v = evaluateAction('state_availability', set('service_identified', 'date_identified'))
    expect(v.permitted).toBe(false)
    expect(v.missing).toContain('availability_verified')
  })

  it('requires a database price before a quote', () => {
    const v = evaluateAction('send_quote', set('service_identified'))
    expect(v.permitted).toBe(false)
    expect(v.missing).toContain('price_from_database')
  })

  it('holds a booking to the full picture', () => {
    const almost = set(
      'customer_identified',
      'service_identified',
      'date_identified',
      'party_size_identified'
    )
    expect(evaluateAction('create_booking', almost).missing).toEqual(['availability_verified'])
    expect(evaluateAction('create_booking', new Set([...almost, 'availability_verified'])).permitted).toBe(
      true
    )
  })

  it('applies the strongest requirements to money', () => {
    expect(evaluateAction('payment_action', set('customer_identified', 'booking_exists')).permitted).toBe(
      false
    )
  })
})

describe('decideDisposition — evidence authorises, the model does not', () => {
  it('holds an unattested quote even when the model rates itself high', () => {
    // The Karin Roberts failure mode: a confident model inventing a figure.
    // A self-rating cannot buy its way past a missing fact.
    const r = decideDisposition({
      evidence: set('customer_identified'),
      modelConfidence: 'high',
      quotesPrice: true,
    })
    expect(r.disposition).toBe('hold')
    expect(r.reasons).toContain('quote_without_database_price')
  })

  it('holds an availability claim that was never verified, at any self-rating', () => {
    for (const c of ['high', 'medium', 'low'] as const) {
      const r = decideDisposition({
        evidence: set('service_identified', 'date_identified'),
        modelConfidence: c,
        claimsAvailability: true,
      })
      expect(r.disposition).toBe('hold')
    }
  })

  it('lets an availability claim through once the schedule was actually checked', () => {
    // check_availability ran this turn (evidence.add('availability_verified') +
    // 'date_identified' in lib/caye-reply.ts) — the claim is now grounded,
    // not just asserted.
    const r = decideDisposition({
      evidence: set('service_identified', 'date_identified', 'availability_verified'),
      modelConfidence: 'high',
      claimsAvailability: true,
    })
    expect(r.disposition).toBe('send')
  })

  it('lets a grounded quote through', () => {
    const r = decideDisposition({
      evidence: set('service_identified', 'price_from_database'),
      modelConfidence: 'high',
      quotesPrice: true,
    })
    expect(r.disposition).toBe('send')
  })

  it('lets the model downgrade, but only downgrade', () => {
    const evidence = set('service_identified', 'price_from_database')
    // Downgrade: allowed.
    expect(decideDisposition({ evidence, modelConfidence: 'medium' }).disposition).toBe(
      'send_and_flag'
    )
    // Upgrade past a missing fact: refused.
    expect(
      decideDisposition({ evidence: set(), modelConfidence: 'high', claimsAvailability: true })
        .disposition
    ).toBe('hold')
  })

  it('sends freely when nothing is being claimed', () => {
    // An ordinary "we're open until 5" answer should not be gated on service
    // matching or party size.
    expect(decideDisposition({ evidence: set(), modelConfidence: 'high' }).disposition).toBe('send')
  })

  it('holds a safety claim made about someone we cannot identify', () => {
    const r = decideDisposition({
      evidence: set(),
      modelConfidence: 'high',
      highStakesClaim: true,
    })
    expect(r.disposition).toBe('hold')
  })

  it('flags rather than holds when the owner asked to be looped in', () => {
    const r = decideDisposition({ evidence: set(), requestsOwnerFollowup: true })
    expect(r.disposition).toBe('send_and_flag')
  })
})

describe('ownerNoteFor — no internal vocabulary reaches the owner', () => {
  const BANNED = [
    'Layer 2',
    'self-rated',
    'confidence=',
    'evidence',
    'disposition',
    'policy',
    'tool',
    'agent',
    'system prompt',
    'orchestrat',
    'availability_verified',
    'price_from_database',
    'model_reported_uncertainty',
  ]

  function assertClean(note: string) {
    for (const term of BANNED) {
      expect(note.toLowerCase()).not.toContain(term.toLowerCase())
    }
  }

  it('explains a held quote in plain words', () => {
    const note = ownerNoteFor({
      disposition: 'hold',
      reasons: ['quote_without_database_price'],
      missing: ['price_from_database'],
    })
    assertClean(note)
    expect(note).toMatch(/price/i)
  })

  it('explains a held availability claim in plain words', () => {
    const note = ownerNoteFor({
      disposition: 'hold',
      reasons: ['availability_claim_unverified'],
      missing: ['availability_verified'],
    })
    assertClean(note)
    expect(note).toMatch(/schedule/i)
  })

  it('replaces the "Layer 2 spec" note that actually reached Mrs. Max', () => {
    // Shipped 2026-08-11 as: "Caye self-rated confidence=medium on her reply.
    // She sent it (per the Layer 2 spec, drafts ship even at medium/low)..."
    const note = ownerNoteFor({
      disposition: 'send_and_flag',
      reasons: ['model_reported_uncertainty'],
      missing: [],
    })
    assertClean(note)
    expect(note).toMatch(/I answered her/i)
    expect(note).toMatch(/nothing is waiting on you/i)
  })

  it('carries the owner’s own note through when there is one', () => {
    const note = ownerNoteFor(
      { disposition: 'send_and_flag', reasons: ['model_reported_uncertainty'], missing: [] },
      'whether the ferry runs on Sundays'
    )
    expect(note).toContain('whether the ferry runs on Sundays')
  })
})

describe('ownerReasonLabelFor — human_agent_reason must never be the raw code', () => {
  // Pam Ott incident, 2026-08-17: `evidenceVerdict.reasons[0]` was written
  // straight into human_agent_reason, so the inbox row literally read
  // "availability_claim_unverified".
  it('never returns a raw machine code', () => {
    const cases: Array<DispositionResult> = [
      { disposition: 'hold', reasons: ['availability_claim_unverified'], missing: ['availability_verified'] },
      { disposition: 'hold', reasons: ['quote_without_database_price'], missing: ['price_from_database'] },
      {
        disposition: 'hold',
        reasons: ['high_stakes_claim_without_verified_context'],
        missing: [],
      },
    ]
    for (const c of cases) {
      const label = ownerReasonLabelFor(c)
      expect(label).not.toBe(c.reasons[0])
      expect(label).not.toContain('_')
    }
  })

  it('labels an unverified availability claim in plain words', () => {
    expect(
      ownerReasonLabelFor({
        disposition: 'hold',
        reasons: ['availability_claim_unverified'],
        missing: ['availability_verified'],
      })
    ).toMatch(/availability/i)
  })
})

describe('partialAvailabilityNoteFor — no internal vocabulary, no false "I held it"', () => {
  it('does not claim the reply was held when it actually shipped', () => {
    const note = partialAvailabilityNoteFor()
    expect(note.toLowerCase()).not.toContain('i held it')
    expect(note).toMatch(/answered what i could/i)
  })

  it('carries the owner note through when there is one', () => {
    const note = partialAvailabilityNoteFor('max group size for the shared tour')
    expect(note).toContain('max group size for the shared tour')
  })
})
