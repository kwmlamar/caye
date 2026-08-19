import { describe, it, expect } from 'vitest'
import {
  attestedFigures,
  detectUnverifiedPaymentFigure,
  detectUnverifiedPaymentMethodClaim,
  detectUnsupportedThirdPartyCommitment,
  detectUnsupportedRefundCommitment,
} from './policy-figure-guard'

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

describe('detectUnverifiedPaymentMethodClaim (2026-08-16, real Bimini cash-acceptance incident)', () => {
  // ── The actual regression ──────────────────────────────────────────
  it('blocks "cash is not accepted" when no business fact mentions cash', () => {
    const draft = "Unfortunately, cash is not accepted — we only take payment via invoice."
    expect(detectUnverifiedPaymentMethodClaim(draft, FACTS)).toMatch(/cash/)
  })

  it('blocks the positive framing too — "yes, we accept cash" is equally invented if ungrounded', () => {
    const draft = 'Yes, we accept cash on the day of the tour.'
    expect(detectUnverifiedPaymentMethodClaim(draft, FACTS)).toMatch(/cash/)
  })

  it('blocks an invented card-only policy', () => {
    const draft = "We're card only, unfortunately — no cash accepted at pickup."
    expect(detectUnverifiedPaymentMethodClaim(draft, FACTS)).toMatch(/cash|card/)
  })

  // ── Grounded claims must pass ──────────────────────────────────────
  it('allows a payment-method claim when the business facts actually document it', () => {
    const facts = `${FACTS}\nWe accept cash or card payment on the day of the tour.`
    expect(detectUnverifiedPaymentMethodClaim('Cash is accepted on the day of your tour.', facts)).toBeNull()
  })

  // ── Must not false-positive on unrelated content ───────────────────
  it('ignores a reply with no payment-method claim at all', () => {
    const draft = 'Your spot is held for November 6. Payment details will follow by invoice.'
    expect(detectUnverifiedPaymentMethodClaim(draft, FACTS)).toBeNull()
  })

  it('ignores the word "card" used in a non-payment sense', () => {
    const draft = 'Bring a printed boarding card if you have one, though it is not required.'
    expect(detectUnverifiedPaymentMethodClaim(draft, FACTS)).toBeNull()
  })

  it('treats empty grounding as attesting no payment method', () => {
    expect(detectUnverifiedPaymentMethodClaim('We accept cash.', '')).toMatch(/cash/)
  })
})

describe('detectUnsupportedThirdPartyCommitment (2026-08-19, CAY-92 Jonathan snorkeling/Snuba incident)', () => {
  // ── Regression fixture 1: the actual incident ─────────────────────────
  it('blocks promising to coordinate snorkeling/Snuba through a partner with no grounding', () => {
    const draft =
      "Thanks for asking, Jonathan! We can coordinate snorkeling and Snuba for you through one " +
      "of our trusted partners."
    expect(detectUnsupportedThirdPartyCommitment(draft, FACTS)).toMatch(/partner/)
  })

  // ── Regression fixture 3: never assert an arrangement already happened ─
  it('blocks an already-arranged claim about a dive operator', () => {
    const draft = "We have arranged your Snuba dive with our local operator for Thursday."
    expect(detectUnsupportedThirdPartyCommitment(draft, FACTS)).toMatch(/operator/)
  })

  // ── Regression fixture 2: owner instruction in-thread authorises it ────
  it('allows the same commitment once the owner said it in the grounding text', () => {
    const ownerInstruction = 'We can coordinate through one of our trusted partners.'
    const draft =
      "Thanks for asking, Jonathan! We can coordinate snorkeling and Snuba for you through one " +
      "of our trusted partners."
    expect(detectUnsupportedThirdPartyCommitment(draft, ownerInstruction)).toBeNull()
  })

  it('allows a stored business fact that already documents the partner arrangement', () => {
    const facts = `${FACTS}\nWe coordinate snorkeling and Snuba trips through our trusted partner, Bimini Undersea.`
    const draft = 'We can coordinate that Snuba trip for you through our partner.'
    expect(detectUnsupportedThirdPartyCommitment(draft, facts)).toBeNull()
  })

  // ── Regression: bare "I'll"/"I can" is NOT a hedge (review on #96) ─────
  it('blocks "I\'ll arrange ... through our partner" — plain future tense, not a hedge', () => {
    const draft = "I'll arrange snorkeling through our partner for you."
    expect(detectUnsupportedThirdPartyCommitment(draft, FACTS)).toMatch(/partner/)
  })

  it('blocks "I can coordinate ... through our vendor" — plain capability, not a hedge', () => {
    const draft = "I can coordinate that with our vendor for you."
    expect(detectUnsupportedThirdPartyCommitment(draft, FACTS)).toMatch(/vendor/)
  })

  // ── Must not block honest uncertainty ──────────────────────────────────
  it('does not block offering to check with a partner rather than promising', () => {
    const draft = "Let me check with our partner on availability and get back to you."
    expect(detectUnsupportedThirdPartyCommitment(draft, FACTS)).toBeNull()
  })

  it('does not block "I\'ll check with our partner" — genuine hedge', () => {
    const draft = "I'll check with our partner and get back to you."
    expect(detectUnsupportedThirdPartyCommitment(draft, FACTS)).toBeNull()
  })

  it('does not block a plain informational reply with no commitment', () => {
    const draft = 'Snorkeling and Snuba are popular add-ons on this island.'
    expect(detectUnsupportedThirdPartyCommitment(draft, FACTS)).toBeNull()
  })

  it('treats empty grounding as attesting no partner arrangement', () => {
    const draft = 'We can arrange that for you through one of our trusted vendors.'
    expect(detectUnsupportedThirdPartyCommitment(draft, '')).toMatch(/vendor/)
  })
})

describe('detectUnsupportedRefundCommitment (2026-08-19, CAY-92)', () => {
  it('blocks an invented full-refund promise', () => {
    const draft = "Not a problem — we'll issue a full refund to your card within 5 business days."
    expect(detectUnsupportedRefundCommitment(draft, INVOICE_FACT)).toMatch(/refund/)
  })

  it('blocks a cancel-and-refund promise with no grounding', () => {
    const draft = "We'll cancel your booking and refund your deposit right away."
    expect(detectUnsupportedRefundCommitment(draft, INVOICE_FACT)).toMatch(/refund/)
  })

  it('allows a refund claim the cancellation policy actually documents', () => {
    const draft =
      "Since this qualifies as a medical emergency, you're entitled to a full refund per our policy."
    expect(detectUnsupportedRefundCommitment(draft, CANCELLATION_FACT)).toBeNull()
  })

  // ── Regression: bare "I'll"/"I can" is NOT a hedge (review on #96) ─────
  it('blocks "I\'ll issue a full refund" — plain future tense, not a hedge', () => {
    const draft = "I'll issue a full refund to your card right away."
    expect(detectUnsupportedRefundCommitment(draft, INVOICE_FACT)).toMatch(/refund/)
  })

  it('blocks "I can refund your deposit" — plain capability, not a hedge', () => {
    const draft = "I can refund your deposit today, no problem."
    expect(detectUnsupportedRefundCommitment(draft, INVOICE_FACT)).toMatch(/refund/)
  })

  it('does not block offering to check on refund eligibility', () => {
    const draft = "Let me check whether this qualifies for a refund and get back to you."
    expect(detectUnsupportedRefundCommitment(draft, FACTS)).toBeNull()
  })

  it('does not block "I can check whether a refund applies" — genuine hedge', () => {
    const draft = "I can check whether a refund applies and get back to you."
    expect(detectUnsupportedRefundCommitment(draft, FACTS)).toBeNull()
  })

  it('treats empty grounding as attesting no refund policy', () => {
    expect(detectUnsupportedRefundCommitment('We will refund your payment in full.', '')).toMatch(/refund/)
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
