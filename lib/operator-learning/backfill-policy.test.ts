import { describe, it, expect } from 'vitest'
import { decideBackfillEligibility, type BackfillPolicyInput } from './backfill-policy'

function base(over: Partial<BackfillPolicyInput> = {}): BackfillPolicyInput {
  return {
    provenance: 'owner_explicit',
    knowledgeType: 'business_fact',
    explicitness: 'explicit_statement',
    scope: { kind: 'standing' },
    risk: 'low',
    hasUnresolvedContradiction: false,
    alreadyRepresented: false,
    ...over,
  }
}

describe('decideBackfillEligibility — provenance is the primary gate', () => {
  it('rejects caye_generated regardless of how confident/explicit the statement reads', () => {
    const d = decideBackfillEligibility(base({ provenance: 'caye_generated', explicitness: 'explicit_statement', risk: 'low' }))
    expect(d.eligibility).toBe('reject')
  })

  it('rejects customer_only regardless of anything else', () => {
    const d = decideBackfillEligibility(base({ provenance: 'customer_only' }))
    expect(d.eligibility).toBe('reject')
  })

  it('never auto-allows provenance_unknown — always at most candidate_only', () => {
    const d = decideBackfillEligibility(base({ provenance: 'provenance_unknown' }))
    expect(d.eligibility).toBe('candidate_only')
  })

  it('holds staff_explicit as candidate_only, matching live authority policy exactly', () => {
    const d = decideBackfillEligibility(base({ provenance: 'staff_explicit' }))
    expect(d.eligibility).toBe('candidate_only')
  })

  it('never auto-allows existing_authoritative_state — always requires a human judgment on the derived form', () => {
    const d = decideBackfillEligibility(base({ provenance: 'existing_authoritative_state' }))
    expect(d.eligibility).toBe('candidate_only')
  })
})

describe('decideBackfillEligibility — scope discipline matches the live router exactly', () => {
  it('rejects customer_scoped regardless of provenance', () => {
    const d = decideBackfillEligibility(base({ provenance: 'owner_explicit', scope: { kind: 'customer_scoped' } }))
    expect(d.eligibility).toBe('reject')
  })

  it('rejects one_off regardless of provenance', () => {
    const d = decideBackfillEligibility(base({ provenance: 'founder_explicit', scope: { kind: 'one_off' } }))
    expect(d.eligibility).toBe('reject')
  })

  it('holds ambiguous scope as candidate_only', () => {
    const d = decideBackfillEligibility(base({ scope: { kind: 'ambiguous' } }))
    expect(d.eligibility).toBe('candidate_only')
  })
})

describe('decideBackfillEligibility — contradiction and explicitness', () => {
  it('requires owner confirmation on any unresolved contradiction, even with real owner evidence', () => {
    const d = decideBackfillEligibility(base({ hasUnresolvedContradiction: true }))
    expect(d.eligibility).toBe('owner_confirmation_required')
  })

  it('holds inferred_from_action as candidate_only even from a real owner source', () => {
    const d = decideBackfillEligibility(base({ explicitness: 'inferred_from_action' }))
    expect(d.eligibility).toBe('candidate_only')
  })
})

describe('decideBackfillEligibility — consequential risk requires confirmation even with real evidence', () => {
  it('never auto-allows consequential content, regardless of provenance quality', () => {
    const d = decideBackfillEligibility(base({ risk: 'consequential' }))
    expect(d.eligibility).toBe('owner_confirmation_required')
  })
})

describe('decideBackfillEligibility — the one path to auto_backfill_allowed', () => {
  it('allows real owner evidence, standing scope, low risk, explicit, no contradiction, not already represented', () => {
    const d = decideBackfillEligibility(base())
    expect(d.eligibility).toBe('auto_backfill_allowed')
  })

  it('allows the same for founder_explicit', () => {
    const d = decideBackfillEligibility(base({ provenance: 'founder_explicit' }))
    expect(d.eligibility).toBe('auto_backfill_allowed')
  })

  it('allows date_scoped standing-equivalent evidence too (not only "standing")', () => {
    const d = decideBackfillEligibility(base({ scope: { kind: 'date_scoped' } }))
    expect(d.eligibility).toBe('auto_backfill_allowed')
  })
})

describe('decideBackfillEligibility — already represented is a hard stop before anything else', () => {
  it('rejects when the fact already exists, even with perfect provenance', () => {
    const d = decideBackfillEligibility(base({ alreadyRepresented: true }))
    expect(d.eligibility).toBe('reject')
  })
})

// ── Applied to the real Bimini findings (2026-08-26 audit) ────────────────
describe('applied to the real Bimini historical-learning findings', () => {
  // A. Bottled water $2.50/guest — the customer-facing reply exists, but no
  // caye_operator_messages / caye_tool_calls row shows an operator
  // approving that figure. Provenance cannot be conclusively traced.
  it('A. bottled water $2.50 — provenance_unknown, so candidate_only (NOT auto owner-direct backfill)', () => {
    const d = decideBackfillEligibility({
      provenance: 'provenance_unknown',
      knowledgeType: 'business_fact',
      explicitness: 'explicit_statement',
      scope: { kind: 'standing' },
      risk: 'low',
      hasUnresolvedContradiction: false,
      alreadyRepresented: false,
    })
    expect(d.eligibility).toBe('candidate_only')
  })

  // B. Water-excursion trusted-partner capability — the owner's own inbound
  // message ("you can send a message to him advising him that we do not do
  // water tours however we are able to coordinate...") is real, traceable,
  // explicit, standing-scoped, low-risk (a capability statement, not a
  // price/refund/payment commitment), and nothing active contradicts it.
  it('B. water-excursion partner capability — real owner_explicit evidence, auto_backfill_allowed', () => {
    const d = decideBackfillEligibility({
      provenance: 'owner_explicit',
      knowledgeType: 'business_fact',
      explicitness: 'explicit_correction',
      scope: { kind: 'standing' },
      risk: 'low',
      hasUnresolvedContradiction: false,
      alreadyRepresented: false,
    })
    expect(d.eligibility).toBe('auto_backfill_allowed')
  })

  // C. Duplicate payment-policy facts — NOT a backfill question at all: both
  // rows already exist as owner-direct business_facts. This is a
  // supersession/reconciliation problem (handled by the semantic-dedup fix
  // in business-fact-writer.ts and the passive-candidate cleanup fix), so
  // the correct policy input marks it already represented.
  it('C. duplicate payment-policy facts — already represented, reject as a backfill candidate (needs reconciliation, not backfill)', () => {
    const d = decideBackfillEligibility({
      provenance: 'owner_explicit',
      knowledgeType: 'business_fact',
      explicitness: 'explicit_correction',
      scope: { kind: 'standing' },
      risk: 'low',
      hasUnresolvedContradiction: false,
      alreadyRepresented: true,
    })
    expect(d.eligibility).toBe('reject')
  })

  // D. Casino Tram Stop candidate — the authoritative fact already exists;
  // the passive candidate is stale, not a new lesson. Same shape as C.
  it('D. Casino Tram Stop candidate — already represented, reject as a backfill candidate (needs candidate cleanup, not backfill)', () => {
    const d = decideBackfillEligibility({
      provenance: 'owner_explicit',
      knowledgeType: 'business_fact',
      explicitness: 'explicit_statement',
      scope: { kind: 'standing' },
      risk: 'low',
      hasUnresolvedContradiction: false,
      alreadyRepresented: true,
    })
    expect(d.eligibility).toBe('reject')
  })
})
