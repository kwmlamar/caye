/**
 * operator-learning/route-decision.ts
 *
 * Pure decision function: given a validated classification and the caller's
 * role, decide whether to attempt a live write, hold as a candidate, or do
 * nothing — before any database or service-resolution work happens. DB-level
 * resolution (does this service exist? is the tier unambiguous?) can still
 * downgrade an 'attempt_write' to a candidate later, in the writer — this
 * function only decides ELIGIBILITY from the classification + authority
 * shape alone, so it's fully unit-testable without mocking Supabase.
 *
 * This is where the task's "Routing hard rules" and "Live-write policy" are
 * enforced as code, not prompt text:
 *   1. Pricing routes to pricing infra, never prose, when resolvable — the
 *      classifier's destination field already encodes this; this function
 *      just gates WHEN a pricing destination is allowed to write.
 *   2/3/4. customer_scoped / one_off scope NEVER writes to any authoritative
 *      store, for ANY destination — enforced unconditionally below.
 *   5. Supersession is the writer's job (this function doesn't touch it).
 *   6. Customer messages never reach this function at all — the router is
 *      only wired into the operator webhook.
 */

import type { ClassificationResult, Destination } from './schema'
import type { Role } from '@/lib/caye-agent/tools/types'

export type RoutingPlan =
  | { action: 'no_op'; reason: string }
  | { action: 'candidate'; destination: Destination; reason: string }
  | { action: 'attempt_write'; destination: Destination; reason: string }

/** Same authority list as every existing durable-write tool (add_business_fact, update_service_price, add_team_member, add_service_availability_rule) — deliberately NOT loosened to include staff. */
const WRITE_AUTHORIZED_ROLES: Role[] = ['owner', 'founder']

const LOW_RISK_MIN_CONFIDENCE = 0.55
const CONSEQUENTIAL_MIN_CONFIDENCE = 0.75

export function decideRouting(input: { classification: ClassificationResult; callerRole: Role }): RoutingPlan {
  const c = input.classification

  if (!c.learnable) {
    return { action: 'no_op', reason: 'not reusable business knowledge' }
  }

  // Rule: customer-specific exceptions and pure one-off instructions must
  // never update a workspace-global store, and must never even sit as a
  // candidate proposing to make them global — the classification itself
  // said this doesn't generalize.
  if (c.scope.kind === 'customer_scoped' || c.scope.kind === 'one_off') {
    return { action: 'no_op', reason: `scope is ${c.scope.kind} — not eligible for any durable/global store` }
  }

  // Resolve the effective destination. A date-scoped correction may have
  // been classified toward a standing destination (e.g. the model reached
  // for business_fact for "we only have private available that day") —
  // reroute to availability_date whenever that payload is actually present,
  // rather than either writing a permanent fact or discarding a resolvable
  // date-scoped rule.
  let destination = c.destination
  if (c.scope.kind === 'date_scoped' && destination !== 'availability_date' && c.availabilityDate) {
    destination = 'availability_date'
  }

  if (destination === 'none') {
    return { action: 'no_op', reason: 'classifier assigned no destination' }
  }

  if (c.scope.kind === 'ambiguous') {
    return { action: 'candidate', destination, reason: 'scope is ambiguous — needs owner clarification' }
  }

  if (c.scope.kind === 'date_scoped') {
    if (destination !== 'availability_date' || !c.availabilityDate || !c.scope.dateISO) {
      return {
        action: 'candidate',
        destination,
        reason: 'date-scoped statement but the date could not be resolved from bounded context',
      }
    }
    // Defense against a self-inconsistent classifier output: the payload's
    // own date must agree with the scope's date. Never let two different
    // dates from the same classification silently pick one — an internally
    // contradictory result is exactly the "genuinely unsure" case that
    // should be held for a human, not guessed at.
    if (c.availabilityDate.dateISO !== c.scope.dateISO) {
      return {
        action: 'candidate',
        destination,
        reason: `scope.dateISO (${c.scope.dateISO}) and availabilityDate.dateISO (${c.availabilityDate.dateISO}) disagree`,
      }
    }
  }

  if (c.scope.kind === 'standing' && destination === 'availability_date') {
    // Inconsistent: a standing-scope classification paired with a
    // date-specific destination contradicts itself — never guess which one
    // is right.
    return { action: 'candidate', destination, reason: 'scope/destination mismatch (standing vs. date-specific)' }
  }

  if (!WRITE_AUTHORIZED_ROLES.includes(input.callerRole)) {
    return {
      action: 'candidate',
      destination,
      reason: `role '${input.callerRole}' is classified/audited but not authorized to write live (owner/founder only)`,
    }
  }

  // An inferred correction (read off an action, not stated outright) or a
  // genuinely ambiguous one never writes live, regardless of risk or
  // confidence — e.g. a price inferred from a single one-off quote.
  if (c.explicitness === 'inferred_from_action' || c.explicitness === 'ambiguous') {
    return { action: 'candidate', destination, reason: `explicitness is ${c.explicitness} — requires confirmation before writing live` }
  }

  const requiredConfidence = c.risk === 'consequential' ? CONSEQUENTIAL_MIN_CONFIDENCE : LOW_RISK_MIN_CONFIDENCE
  if (c.confidence < requiredConfidence) {
    return {
      action: 'candidate',
      destination,
      reason: `confidence ${c.confidence.toFixed(2)} below the ${c.risk} threshold (${requiredConfidence})`,
    }
  }

  return { action: 'attempt_write', destination, reason: 'explicit, authorized, unambiguous-scope correction' }
}
