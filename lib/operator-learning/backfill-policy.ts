/**
 * operator-learning/backfill-policy.ts
 *
 * Pure, deterministic eligibility policy for HISTORICAL backfill only — a
 * one-time human-reviewed pass that captures durable knowledge a business
 * already lived by but never recorded, distinct from the live
 * operator-learning-router pipeline (which classifies a message the moment
 * it arrives). Added after the 2026-08-26 historical-learning audit
 * exposed a real risk: the bottled-water reply Caye sent a customer stated
 * "$2.50 per guest", but nothing in available data proves who actually
 * decided that number. Labeling it `owner-direct` merely because Caye said
 * it to a customer would fabricate provenance that doesn't exist.
 *
 * THE CORE RULE THIS FILE EXISTS TO ENFORCE:
 * A fact having been TOLD to a customer is not evidence of who AUTHORIZED
 * it. Only an actual owner/founder/staff message, or already-trusted
 * structured state, is evidence. Caye's own outbound text and a customer's
 * own words are never teaching authority — no matter how confidently or
 * how many times they were repeated.
 *
 * This module NEVER executes a backfill. It only classifies eligibility;
 * the actual write (if any) happens through the ordinary write path
 * (add_business_fact / a human-reviewed migration script), never through
 * this function.
 */

/**
 * Where a historical candidate fact's TEXT actually traces back to —
 * distinct from `Explicitness`/`Scope`/`RiskLevel` (schema.ts), which
 * describe the STATEMENT once a source is established. This describes
 * whether a source with real teaching authority exists at all.
 *
 * - owner_explicit / founder_explicit / staff_explicit: a real
 *   operator_allowlist-identified person's own words are the evidence.
 * - existing_authoritative_state: the "fact" is already fully represented
 *   in a trusted structured store (business_facts, service_pricing_tiers,
 *   service_availability_rules, service_date_overrides, operator_allowlist)
 *   — backfill here means DERIVING a summary/prose form, not asserting new
 *   truth, so it carries different risk than a brand-new claim.
 * - customer_only: the only source is the customer's own words (e.g. "you
 *   told me $2.50" or a question that implies an answer). Never authority.
 * - caye_generated: the only source is Caye's own historical output
 *   (a sent reply, a draft, an internal note) with no traceable
 *   operator instruction behind it. Never authority, regardless of how
 *   confidently or consistently Caye said it.
 * - provenance_unknown: a plausible operator source exists somewhere in
 *   history but could not be conclusively traced from available data (the
 *   bottled-water case: an answer was sent, no operator approval is
 *   visible in caye_operator_messages or caye_tool_calls for that window).
 */
export type HistoricalProvenance =
  | 'owner_explicit'
  | 'founder_explicit'
  | 'staff_explicit'
  | 'existing_authoritative_state'
  | 'customer_only'
  | 'caye_generated'
  | 'provenance_unknown'

export type HistoricalKnowledgeType = 'business_fact' | 'pricing' | 'contact' | 'availability_recurring' | 'availability_date'

export type BackfillEligibility = 'auto_backfill_allowed' | 'candidate_only' | 'owner_confirmation_required' | 'reject'

export interface BackfillPolicyInput {
  provenance: HistoricalProvenance
  knowledgeType: HistoricalKnowledgeType
  /** Same meaning as ClassificationResult.explicitness (schema.ts) — how directly the source stated this, once a source is established. */
  explicitness: 'explicit_statement' | 'explicit_correction' | 'inferred_from_action' | 'ambiguous'
  scope: { kind: 'standing' | 'date_scoped' | 'customer_scoped' | 'one_off' | 'ambiguous' }
  risk: 'low' | 'consequential'
  /** True when this candidate contradicts something already active and the contradiction hasn't been resolved by a human. */
  hasUnresolvedContradiction: boolean
  /** True when an equivalent fact is ALREADY correctly represented in the authoritative store — i.e. there's nothing to backfill. */
  alreadyRepresented: boolean
}

export interface BackfillDecision {
  eligibility: BackfillEligibility
  reason: string
}

const NEVER_AUTHORITY: readonly HistoricalProvenance[] = ['caye_generated', 'customer_only']
const REAL_OPERATOR_SOURCE: readonly HistoricalProvenance[] = ['owner_explicit', 'founder_explicit']

export function decideBackfillEligibility(input: BackfillPolicyInput): BackfillDecision {
  if (input.alreadyRepresented) {
    return { eligibility: 'reject', reason: 'already correctly represented in the authoritative store — nothing to backfill' }
  }

  // Never authority, regardless of anything else about the statement —
  // this check comes first and nothing downstream can override it.
  if (NEVER_AUTHORITY.includes(input.provenance)) {
    return {
      eligibility: 'reject',
      reason: `provenance is ${input.provenance} — a customer's words or Caye's own generated text are never teaching authority, no matter how the statement reads`,
    }
  }

  // Same hard rule the live router enforces (route-decision.ts): a
  // customer-specific or pure one-off statement never becomes durable
  // knowledge, historical or otherwise — provenance being real doesn't
  // change what the statement itself actually generalizes to.
  if (input.scope.kind === 'customer_scoped' || input.scope.kind === 'one_off') {
    return { eligibility: 'reject', reason: `scope is ${input.scope.kind} — not eligible for backfill into any durable/global store regardless of provenance` }
  }

  if (input.provenance === 'provenance_unknown') {
    return {
      eligibility: 'candidate_only',
      reason: 'a real operator source plausibly exists but could not be conclusively traced from available data — never backfilled live without confirmation',
    }
  }

  // Unresolved contradiction always forces a human decision — a backfill
  // pass must never silently pick a side between two historical
  // statements that disagree.
  if (input.hasUnresolvedContradiction) {
    return { eligibility: 'owner_confirmation_required', reason: 'contradicts existing/other historical evidence — a human must pick which one governs' }
  }

  if (input.scope.kind === 'ambiguous') {
    return { eligibility: 'candidate_only', reason: 'scope is ambiguous — needs clarification before it can be trusted as standing/global' }
  }

  if (input.explicitness === 'inferred_from_action' || input.explicitness === 'ambiguous') {
    return { eligibility: 'candidate_only', reason: `explicitness is ${input.explicitness} — never backfilled live without confirmation, same as the live router` }
  }

  if (input.provenance === 'existing_authoritative_state') {
    // Deliberately never auto: whether a derived summary is even the RIGHT
    // shape for this specific structured state is a product judgment this
    // function cannot make on its own — see the type's own doc comment.
    return {
      eligibility: 'candidate_only',
      reason: 'already-trusted structured state may support a DERIVED summary, but deciding the right derived form is a human judgment call, not an automatic one',
    }
  }

  if (input.provenance === 'staff_explicit') {
    // Matches live authority policy exactly (route-decision.ts,
    // WRITE_AUTHORIZED_ROLES): staff statements are never written live,
    // historical or current — visible for owner confirmation only.
    return { eligibility: 'candidate_only', reason: 'staff-sourced — same as live policy, visible for owner confirmation but never auto-written' }
  }

  // From here on: provenance is owner_explicit or founder_explicit, scope
  // is standing/date_scoped (never customer_scoped/one_off/ambiguous —
  // already excluded above), explicitness is a real statement or
  // correction, and there is no unresolved contradiction.
  if (!REAL_OPERATOR_SOURCE.includes(input.provenance)) {
    // Unreachable given the checks above, but fail closed rather than
    // silently falling through to auto-allow if a new provenance value is
    // ever added without updating this function.
    return { eligibility: 'candidate_only', reason: `unrecognized provenance ${input.provenance} — fails closed` }
  }

  if (input.risk === 'consequential') {
    // Same principle as the live router's consequential gate, applied to
    // backfill: an owner/founder's real historical words are good evidence
    // of INTERPRETATION, but consequential business state (pricing,
    // refunds, payment methods, contracts with third parties) still gets a
    // human's eyes once before it's trusted as backfilled truth — a
    // backfill pass runs unattended, with no live conversational
    // back-and-forth to catch a misread the way an in-the-moment owner
    // reply could.
    return { eligibility: 'owner_confirmation_required', reason: 'consequential risk — real operator evidence exists but still requires a human confirmation pass before backfill' }
  }

  return { eligibility: 'auto_backfill_allowed', reason: 'real owner/founder evidence, standing/date-scoped, low risk, explicit, no contradiction, not already represented' }
}
