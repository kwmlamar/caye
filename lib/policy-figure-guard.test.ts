import { describe, it, expect } from 'vitest'
import { attestedFigures, detectUnverifiedPaymentFigure } from './policy-figure-guard'

// The cancellation policy Karenda actually dictated on 2026-08-07, as stored.
const CANCELLATION_FACT =
  'Cancellation & Refund Policy: Cancellations are accepted in the case of serious illness, ' +
  'death, medical emergencies, or if the ship cancels due to weather — these qualify for a full ' +
  'refund. Should a refund be approved outside of these reasons, a $30–$50 administrative ' +
  'processing fee will be deducted from the refund amount.'

const INVOICE_FACT =
  'Payment is collected via invoice sent to the customer — not via payment link or direct ' +
  'instructions in the reply thread.'

const FACTS = `${CANCELLATION_FACT}\n${INVOICE_FACT}`

describe('detectUnverifiedPaymentFigure', () => {
  // ── The regression this module exists for ─────────────────────────────
  it('blocks the invented 25% deposit sent to Karin Roberts', () => {
    const draft =
      'Thank you, Karin. We are pleased to hold your spot for the Full Bimini Experience on ' +
      'Friday, November 6, 2026 for 2 adults at $199/person ($398 total).\n\n' +
      'To secure the date, a 25% deposit ($99.50) is required at booking.'
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toMatch(/25%/)
  })

  it('blocks the contradictory 50% deposit drafted for the same customer', () => {
    const draft =
      'To formally hold your reservation for the Full Bimini Experience, we require a 50% ' +
      'deposit ($199.00) at the time of booking, with the remaining balance of $199.00 due ' +
      '7 days prior to your travel date.'
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toMatch(/50%/)
  })

  it('blocks a bare deposit amount with no rate to justify it', () => {
    const draft = 'A deposit of $150 is required to hold the date.'
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toMatch(/\$150/)
  })

  // ── Grounded figures must pass ────────────────────────────────────────
  it('allows a deposit rate that a business fact attests', () => {
    const facts = `${FACTS}\nA 50% deposit is required at booking to hold the reservation.`
    const draft = 'We require a 50% deposit ($199.00) at the time of booking.'
    expect(detectUnverifiedPaymentFigure(draft, facts)).toBeNull()
  })

  it('allows the $30-$50 processing fee quoted verbatim from the policy', () => {
    const draft =
      'Should a refund be approved outside of these circumstances, a $30–$50 administrative ' +
      'processing fee will be deducted from the refund amount.'
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toBeNull()
  })

  it('matches $199.00 against a fact written as $199', () => {
    const facts = 'A deposit of $199 holds the date.'
    expect(detectUnverifiedPaymentFigure('A deposit of $199.00 holds the date.', facts)).toBeNull()
  })

  it('matches a rate written as "50 percent" in the fact', () => {
    const facts = 'We take 50 percent up front as a deposit.'
    expect(detectUnverifiedPaymentFigure('A 50% deposit is required.', facts)).toBeNull()
  })

  // ── Must not touch ordinary pricing ──────────────────────────────────
  it('ignores plain price quotes, which lookup_price already governs', () => {
    const draft =
      'Full Bimini Experience (4 hours, shared): $199/person, $398 total\n' +
      'North Bimini Heritage Tour (2 hours, shared): $220 total'
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toBeNull()
  })

  it('ignores a reply with no figures at all', () => {
    const draft =
      "Your spot is held for November 6. We'll send payment details over shortly to lock it in."
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toBeNull()
  })

  it('ignores non-payment sentences that happen to contain numbers', () => {
    const draft = 'The tour runs 2 hours and departs at 9:00 with 12 guests maximum.'
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toBeNull()
  })

  it('does not flag a deposit sentence when no figure is stated', () => {
    const draft = 'A deposit is required to hold the date; the owner will send an invoice.'
    expect(detectUnverifiedPaymentFigure(draft, FACTS)).toBeNull()
  })

  it('treats empty grounding as attesting nothing', () => {
    expect(detectUnverifiedPaymentFigure('A 25% deposit is required.', '')).toMatch(/25%/)
  })
})

describe('attestedFigures', () => {
  it('keeps percentages and amounts in separate sets', () => {
    expect(attestedFigures('a 50% deposit, plus a $30–$50 fee')).toEqual({
      percentages: new Set(['50']),
      amounts: new Set(['30', '50']),
    })
  })

  it('normalizes thousands separators and trailing zeros', () => {
    expect(attestedFigures('$1,200.00')).toEqual({
      percentages: new Set(),
      amounts: new Set(['1200']),
    })
  })

  // The unit collision that let the invented "50% deposit" through on the
  // first pass: a dollar fee must never attest a percentage rate.
  it('does not let a $50 fee attest a 50% rate', () => {
    const facts = 'A $30–$50 administrative processing fee applies to approved refunds.'
    expect(detectUnverifiedPaymentFigure('A 50% deposit is required.', facts)).toMatch(/50%/)
  })
})
